import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { checkCategory } from "./category.js";
import { Discord } from "./discord.js";
import { BlockedError, BrowserError, Fetcher, LoginRequired } from "./fetcher.js";
import { log, sleep } from "./log.js";
import { SESSION_DEAD } from "./browser.js";
import { arrivalLine, doBuy, lostRace, watchUntilPaid } from "./order.js";
import { label, lookup, priceText, stockText } from "./parse.js";
import type { BuyEntry, BuyTarget, Config, ProductInfo, ProductState, State } from "./types.js";

// ---------------------------------------------------------------------------
// 구매 판단 — lotte-test/watch.ts 의 handleTarget 을 옮긴 것이다.
// ---------------------------------------------------------------------------

/**
 * 품절로 진 것이 이만큼 **잇달아** 나오면 그때는 쉰다.
 * 조회는 판다고 하는데 주문서에서는 품절이라 하는 일이 계속되면 몇 번마다 창을 띄우는
 * 헛바퀴가 된다. 그걸 끊는 자리다.
 */
const LOST_RACE_LIMIT = 3;

/** 같은 말을 매 바퀴 하지 않으려고 센다. */
const SAID = new Set<string>();
function sayOnce(key: string, say: () => void): void {
  if (SAID.has(key)) return;
  SAID.add(key);
  say();
}

export function buyEntry(state: State, productId: string): BuyEntry {
  const all = (state._buy ??= {}) as Record<string, BuyEntry>;
  return (all[productId] ??= {});
}

/** 지금 살 수 있는가. → [살 수 있나, 못 사는 이유] */
export function buyableNow(info: ProductInfo, target: BuyTarget): [boolean, string] {
  if (!info.inStock) return [false, label(info.status)];
  if (info.stock === 0) return [false, "재고 0"];
  if (target.option && info.options.length) {
    const row = info.options.find((o) => o.name.includes(target.option));
    if (!row) return [false, `옵션 '${target.option}' 이 목록에 없습니다`];
    if (row.stock === 0 || !row.usable) return [false, `옵션 '${row.name}' 품절`];
  }
  return [true, ""];
}

/** 아직 쉬는 중인가. → 남은 분 (아니면 null) */
function onCooldown(entry: BuyEntry, minutes: number): number | null {
  if (!minutes || !entry.last_try_at) return null;
  const elapsed = Date.now() - new Date(entry.last_try_at).getTime();
  if (Number.isNaN(elapsed) || elapsed >= minutes * 60_000) return null;
  return Math.floor((minutes * 60_000 - elapsed) / 60_000) + 1;
}

export interface BuyIO {
  sessionPath: string;
  dumpPath: string;
  dryRun: boolean;
}

/**
 * 읽은 재고를 보고 판단해, 열려 있으면 산다. → 샀으면(여기까지 데려왔으면) true
 *
 * **조용히 돌아서지 않는다.** 이미 샀거나 쉬는 중인 상품을 말없이 넘기면 화면에는 "감시 중"
 * 만 뜨는데 정작 그 상품은 안 사고 있다 — 이 프로젝트에서 제일 나쁜 상태다.
 */
export async function handleBuy(
  cfg: Config, discord: Discord, state: State, target: BuyTarget, info: ProductInfo, io: BuyIO,
): Promise<boolean> {
  const key = target.productId;
  const entry = buyEntry(state, key);
  const name = target.label || info.name;
  entry.name = name;

  if (entry.done) {
    sayOnce(`done:${key}`, () => log.info(`[${key}] ${name} — 이미 샀습니다 (--reset 으로 지웁니다)`));
    return false;
  }
  const left = onCooldown(entry, cfg.buy.cooldownMinutes);
  if (left) {
    sayOnce(`cool:${key}`, () => log.warn(`[${key}] ${name} — 쉬는 중입니다. ${left}분 뒤에 다시 삽니다 (마지막 시도 ${entry.last_try_at})`));
    return false;
  }

  const was = entry.buyable;
  const [now, why] = buyableNow(info, target);
  entry.buyable = now;
  if (!now) {
    if (was) log.info(`[${key}] ${name} — 살 수 없게 바뀌었습니다 (${why})`);
    delete entry.lost_races;
    return false;
  }

  // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다. 처음 본 것도 사지 않는다 — 설정을
  // 잘못 써 놓고 켰을 때 곧장 결제까지 가 버리는 사고가 여기서 막힌다.
  if (cfg.buy.buyOnRestockOnly && was !== false) {
    sayOnce(`hint:${key}`, () => {
      log.info(`[${key}] ${name} — 이미 판매 중입니다. 품절됐다가 다시 열릴 때 삽니다`);
      log.info(`   지금 사려면:  npm start -- --buy ${target.url}`);
    });
    return false;
  }

  const price = info.discounted ?? info.price;
  const limit = target.maxPrice || cfg.buy.maxPrice;
  if (limit && price && price > limit) {
    const reason = `가격이 상한을 넘습니다 — ${priceText(price)} > ${priceText(limit)}`;
    sayOnce(`price:${key}:${price}`, () => log.warn(`[${key}] 사지 않습니다 — ${reason}`));
    entry.blocked = reason;
    await discord.buyBlocked(cfg, target, reason);
    return false;
  }

  log.info(`🟢 [${key}] ${name} — 구매 가능, 구매하기를 누릅니다 (×${target.ea}${target.option ? ` · ${target.option}` : ""})`);
  entry.last_try_at = new Date().toISOString();
  delete entry.blocked;

  const got = await doBuy(cfg, io.sessionPath, target, io.dumpPath, io.dryRun);
  entry.opened = got.ok;
  entry.stage = got.stage;

  if (got.dead) {
    entry.blocked = SESSION_DEAD;
    await discord.buySession(cfg);
    throw new LoginRequired(`구매 창이 네이버 로그인 페이지로 넘어갔습니다.\n  npm start -- --login  으로 다시 로그인하세요.`);
  }

  if (!got.ok && lostRace(got.reason)) {
    const lost = (entry.lost_races ?? 0) + 1;
    entry.lost_races = lost;
    entry.blocked = got.reason ?? undefined;
    if (lost < LOST_RACE_LIMIT) {
      // **쉬지 않는다.** 품절로 적어 두면 조회가 다시 판다고 하는 순간이 곧 "바뀌는 순간" 이 된다.
      delete entry.last_try_at;
      entry.buyable = false;
      log.warn(`[${key}] 한발 늦었습니다 — ${got.reason} (잇달아 진 것 ${lost}/${LOST_RACE_LIMIT}, 쉬지 않고 다음 재입고를 봅니다)`);
      await discord.buyBlocked(cfg, target, `한발 늦었습니다 — ${got.reason}`);
      return false;
    }
    log.warn(`[${key}] ${lost}번 잇달아 품절로 막혔습니다 — 조회와 사이트가 어긋나는 것 같아 쉽니다`);
    delete entry.lost_races;
  }

  if (!got.ok) {
    entry.blocked = got.reason ?? undefined;
    log.warn(`[${key}] 주문서를 못 열었습니다 — ${got.reason}`);
    await discord.buyBlocked(cfg, target, `주문서를 못 열었습니다 — ${got.reason}`);
    return false;
  }

  delete entry.lost_races;
  entry.opened_at = new Date().toISOString();
  entry.done = cfg.buy.stopAfterSuccess && !io.dryRun;
  // 손댈 차례를 먼저 알린다. 결제 완료를 지켜보는 것은 그다음이다 — 거꾸로 하면 "결제해
  // 주세요" 가 결제를 지켜보는 몇 분이 다 지난 뒤에 간다.
  if (!io.dryRun) await discord.buyOpened(cfg, target, info, got.stage, got.note);
  if (got.stage === "submitted" && got.buyer) await watchUntilPaid(cfg, discord, got.buyer, target, name);
  return true;
}

// 실측 기준선: 로그인 세션으로 9.4회/분을 2시간 34분(1,446회) 유지해 차단 0건이었다.
// 로그인 세션은 막히면 스크립트가 아니라 계정이 걸리므로 권장선을 그 근처로 둔다.
export const RATE_WARN_PER_MIN = 10;
export const RATE_HARD_PER_MIN = 30;

/**
 * 분당 / 하루 요청 수.
 * 상품 상세는 조회 1회당 앱 호스트 요청 1건으로 실측됐다.
 * 카테고리 목록은 실측하지 못했다 — 상품 카드를 size 개 실어 오므로 1건보다 비쌀 수 있다.
 * 그래서 이 계산은 낙관적인 하한이다.
 */
export function rateOf(nProducts: number, interval: number, nCategories = 0, catInterval = 300) {
  let perMin = (nProducts * 60) / Math.max(interval, 1);
  // 카테고리 간격이 0 이면 '매 회차' 라는 뜻이라 상품 주기를 따른다
  if (nCategories) perMin += (nCategories * 60) / Math.max(catInterval || interval, 1);
  return { perMin, perDay: perMin * 60 * 24 };
}

/** 차단당하면 물러났다가 천천히 돌아온다. 같은 속도로 계속 두드리면 일시 차단이 장기 차단으로 굳는다. */
class Throttle {
  strikes = 0;
  notified = false;
  constructor(
    private readonly first = 120,
    private readonly cap = 3600,
  ) {}

  blocked(): number {
    this.strikes++;
    const penalty = Math.min(this.first * 2 ** (this.strikes - 1), this.cap);
    log.warn(`차단 감지 (${this.strikes}회 연속) — ${penalty}초 물러납니다`);
    return penalty;
  }

  ok(): void {
    if (this.strikes) log.info(`접근 정상화 — 백오프 해제 (${this.strikes}회 만에)`);
    this.strikes = 0;
    this.notified = false;
  }
}

/** 알릴 만한 변화인가. */
export function changed(info: ProductInfo, prev: Partial<ProductState> | undefined): boolean {
  if (!prev || Object.keys(prev).length === 0) return false;
  if (info.status !== prev.status) return true;
  // 상태는 그대로인데 수량만 0 → N 으로 바뀌는 경우
  return typeof prev.stock === "number" && typeof info.stock === "number" && prev.stock === 0 && info.stock > 0;
}

export function loadState(path: string): State {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\u{FEFF}/u, "")) as State;
  } catch {
    log.warn(`상태 파일이 깨져 새로 시작합니다: ${path}`);
    return {};
  }
}

// 쓰는 도중 죽어도 상태 파일이 깨지지 않게 임시 파일에 쓰고 바꿔치기한다.
export function saveState(path: string, state: State, dryRun: boolean): void {
  if (dryRun) return;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

export interface WatchIO {
  statePath: string;
  dryRun: boolean;
  once: boolean;
  signal: AbortSignal;
  /** 사는 데 필요한 것. null 이면 사지 않는다 (지금까지처럼 알림만). */
  buy: BuyIO | null;
}

/** 반환값이 종료 코드다. 요청률이 거부선을 넘으면 예외를 던진다. */
export async function watch(cfg: Config, fetcher: Fetcher, discord: Discord, io: WatchIO): Promise<number> {
  const { products: urls, categories: cats } = cfg;
  const interval = cfg.checkIntervalSeconds;
  const catMs = cfg.categoryIntervalSeconds * 1000;
  const gapMs = cfg.delayBetweenProductsSeconds * 1000;
  const { perMin, perDay } = rateOf(urls.length, interval, cats.length, cfg.categoryIntervalSeconds);

  log.info(
    `감시 시작 — 상품 ${urls.length}개 ${interval}초 간격 / 카테고리 ${cats.length}개 ${cfg.categoryIntervalSeconds}초 간격 ` +
      `(합계 약 ${perMin.toFixed(1)}회/분, 하루 약 ${Math.round(perDay).toLocaleString("ko-KR")}회)`,
  );
  if (perMin > RATE_HARD_PER_MIN) {
    throw new Error(
      `요청률이 너무 높습니다 (${perMin.toFixed(1)}회/분). ${RATE_HARD_PER_MIN}회/분 아래로 낮추세요 ` +
        `(상품 ${urls.length}개면 간격 ${Math.ceil((urls.length * 60) / RATE_HARD_PER_MIN)}초 이상).`,
    );
  }
  if (perMin > RATE_WARN_PER_MIN) {
    log.warn(`요청률이 권장선(${RATE_WARN_PER_MIN}회/분)보다 높습니다 (${perMin.toFixed(1)}회/분). 로그인 세션이 막힐 위험이 있습니다.`);
  }

  // 살 상품. 같은 상품인지는 주소가 아니라 상품번호로 본다.
  const buying = new Map(io.buy ? cfg.buy.targets.map((t) => [t.productId, t] as const) : []);
  let bought = 0;
  if (buying.size) {
    log.info(`🛒 구매 대상 ${buying.size}개 · 최대 ${cfg.buy.maxBuysPerRun}개 · ` +
      (cfg.buy.buyOnRestockOnly ? "품절 → 구매가능 으로 바뀔 때만 삽니다" : "재고가 있으면 바로 삽니다"));
    log.info(`🛒 ${arrivalLine(cfg)}`);
    for (const t of buying.values()) {
      log.info(`   [${t.productId}] ${t.label || t.url} ×${t.ea}${t.option ? ` · 옵션 ${t.option}` : ""}`);
    }
  } else if (cfg.buy.targets.length) {
    log.info("🛒 구매 대상이 있지만 이번 실행은 사지 않습니다 (--no-buy)");
  }

  const state = loadState(io.statePath);
  const throttle = new Throttle();
  const fails = new Map<string, number>();
  let firstRun = !state._meta?.startup_notified;
  // 시작 요약은 모든 대상이 (성공이든 실패든) 확인된 뒤에 한 번만 보낸다.
  // 차단·Ctrl+C 로 끊긴 첫 회차에 빈 요약을 보내고 '완료' 로 기록하면 진짜 요약은 영영 안 간다.
  const startup = new Map<string, { url: string; info?: ProductInfo; err?: string }>();
  let nextCat = 0; // 첫 회차에 바로 한 번 훑어 기준선을 만든다

  const save = (): void => saveState(io.statePath, state, io.dryRun);

  // 실패를 세고, 정해진 횟수에 딱 한 번만 디스코드로 알린다.
  const countFailure = async (key: string, title: string, e: unknown): Promise<void> => {
    const n = (fails.get(key) ?? 0) + 1;
    fails.set(key, n);
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`${title} (${n}회) ${key}: ${msg}`);
    if (n === cfg.errorNotifyAfter) await discord.alert(title, `${key}\n\`\`\`${msg}\`\`\``, { color: Discord.gray });
  };

  const onBlocked = async (e: BlockedError, where: string): Promise<void> => {
    const wait = throttle.blocked();
    log.warn(`차단 — ${e.message} (${where})`);
    if (!throttle.notified) {
      await discord.alert("⚠ 네이버가 요청을 막았습니다", `\`\`\`${e.message}\`\`\`\n${wait}초 물러났다가 재시도합니다.`, {
        color: Discord.amber,
      });
      throttle.notified = true;
    }
    await sleep(wait * 1000, io.signal);
  };

  const onLoginRequired = async (e: LoginRequired): Promise<number> => {
    log.error(e.message);
    await discord.alert("⚠ 네이버 로그인 세션 만료", `\`\`\`${e.message}\`\`\`\n감시를 멈춥니다. 다시 로그인한 뒤 재실행하세요.`, {
      mention: cfg.restockMention,
    });
    save();
    return 1;
  };

  // 브라우저를 못 띄우는 건 네이버와 무관한 환경 문제다. '확인 실패' 로 세어 봐야 소용없으니 알리고 멈춘다.
  const onBrowserError = async (e: BrowserError): Promise<number> => {
    log.error(e.message);
    await discord.alert("⚠ 브라우저를 실행하지 못했습니다", `${e.message}
감시를 멈춥니다.`, { color: Discord.gray });
    save();
    return 1;
  };

  while (!io.signal.aborted) {
    for (const [i, url] of urls.entries()) {
      if (io.signal.aborted) break;

      let info: ProductInfo;
      try {
        info = lookup(url, await fetcher.state(url));
      } catch (e) {
        if (e instanceof LoginRequired) return onLoginRequired(e);
        if (e instanceof BrowserError) return onBrowserError(e);
        if (e instanceof BlockedError) {
          await onBlocked(e, url);
          continue;
        }
        await countFailure(url, "확인 실패", e);
        if (firstRun) startup.set(url, { url, err: e instanceof Error ? e.message : String(e) });
        continue;
      }

      fails.delete(url);
      throttle.ok();
      const prev = state[url] as ProductState | undefined;
      log.info(`${info.name} — ${label(info.status)} (재고 ${stockText(info.stock)})`);

      if (changed(info, prev)) {
        log.info(`변화 감지: ${label(prev?.status)} → ${label(info.status)}`);
        await discord.change(cfg, info, prev?.status ?? null);
      }

      state[url] = { status: info.status, stock: info.stock, name: info.name, checked: new Date().toISOString() } satisfies ProductState;
      if (firstRun) startup.set(url, { url, info });

      const target = buying.get(info.productId);
      if (target && io.buy) {
        try {
          if (await handleBuy(cfg, discord, state, target, info, io.buy)) bought++;
        } catch (e) {
          if (e instanceof LoginRequired) {
            // 세션 알림은 handleBuy 가 이미 보냈다. 같은 말을 두 번 보내지 않는다.
            log.error(e.message);
            save();
            return 1;
          }
          // 이 상품 하나의 일이다. **한 상품이 자빠졌다고 감시를 접지 않는다.**
          log.error(`[${info.productId}] 사다가 끊겼습니다 — ${(e as Error).message}`);
          buyEntry(state, info.productId).blocked = (e as Error).message;
        }
        save();
        if (bought >= cfg.buy.maxBuysPerRun) {
          log.info(`⭐ ${bought}개를 여기까지 데려왔습니다. 감시를 멈춥니다`);
          return 0;
        }
      }

      if (i < urls.length - 1) await sleep(gapMs, io.signal);
    }

    // 카테고리는 상품보다 훨씬 뜸하게 본다. 신상품이 20초마다 올라오지는 않는다.
    if (cats.length && Date.now() >= nextCat && !io.signal.aborted) {
      for (const [j, catUrl] of cats.entries()) {
        try {
          await checkCategory(cfg, fetcher, discord, state, catUrl);
          fails.delete(catUrl);
          throttle.ok();
        } catch (e) {
          if (e instanceof LoginRequired) return onLoginRequired(e);
          if (e instanceof BrowserError) return onBrowserError(e);
          if (e instanceof BlockedError) await onBlocked(e, catUrl);
          else await countFailure(catUrl, "카테고리 확인 실패", e);
        }
        if (j < cats.length - 1) await sleep(gapMs, io.signal);
      }
      nextCat = Date.now() + catMs;
    }

    // 전부 실패한 회차는 요약으로 치지 않는다 — 그러면 '시작 완료' 로 기록돼 정상 요약이 영영 안 간다
    const resolved = startup.size >= urls.length && (urls.length === 0 || [...startup.values()].some((v) => v.info));
    if (firstRun && !io.signal.aborted && resolved) {
      await discord.startup(cfg, [...startup.values()], perMin, cats.length);
      (state._meta ??= {}).startup_notified = true;
      firstRun = false;
      startup.clear();
    }

    save();
    if (io.once) return 0;

    // 고정 간격은 봇 티가 난다. 매 회차 조금씩 흔든다.
    let waitMs = Math.max(1, interval - urls.length * cfg.delayBetweenProductsSeconds) * 1000;
    // 카테고리만 감시할 땐 상품 주기로 헛돌 이유가 없다
    if (!urls.length && cats.length) waitMs = Math.max(1000, nextCat - Date.now());
    waitMs *= 1 + (Math.random() * 2 - 1) * cfg.intervalJitterRatio;
    await sleep(waitMs, io.signal);
  }

  save();
  log.info("종료합니다.");
  return 0;
}
