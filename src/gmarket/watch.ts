/**
 * 지켜보다가 열리면 산다. (스마트스토어 판 ../watch.ts · 롯데온 판 lotte-test/watch.ts 짜임)
 *
 * 재입고 알림은 파이썬 판(gmarket_item_stock.py)과 같은 일을 한다 — 품절 → 구매가능 으로
 * 바뀌면 디스코드로 알린다. 거기에 더해 buy.targets 에 적힌 상품이면 **그 순간 산다.**
 * 그래서 이 판을 돌리는 동안은 파이썬 판을 끄는 것이 맞다 — 같이 돌리면 요청이 두 배다.
 *
 * **Cloudflare 봇 확인이 뜨면** 두드리지 않는다. 디스코드로 알리고, (창 없이 돌았으면 창을 띄워)
 * 감시 탭에 그 화면을 띄워 사람이 마치기를 기다리고, 그 뒤로는 주기를 두 배로 늦춘다 (최대 60초).
 * 확인 문구 자체가 "고객님의 사이트 내 활동이 봇의 동작과 유사해 보입니다" 다 — 촘촘하게 본 것이 원인이다.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { log, sleep } from "../log.js";
import { BOT_CHECK_SAID, SESSION_DEAD } from "./browser.js";
import { arrivalLine, type BuyTarget, type Config, type Stage } from "./config.js";
import { Discord } from "./discord.js";
import { doBuy, lostRace, watchUntilPaid } from "./order.js";
import { priceText, statusText, type ItemInfo } from "./parse.js";
import { BlockedError, BotCheckError, type Watcher } from "./session.js";

/**
 * 품절로 진 것이 이만큼 **잇달아** 나오면 그때는 쉰다. 조회는 판다고 하는데 주문서에서는
 * 품절이라 하는 일이 계속되면 몇 초마다 창을 띄우는 헛바퀴가 된다.
 */
const LOST_RACE_LIMIT = 3;
const IN_STOCK = "instock";
const SOLDOUT = "soldout";

/** 상태 파일에 상품마다 적어 두는 것 (재입고 감시 쪽). */
export interface ItemEntry {
  name?: string;
  price?: number | null;
  status?: typeof IN_STOCK | typeof SOLDOUT;
  since?: string;
  checked_at?: string;
  last_alert_at?: string;
}

/** 상태 파일에 상품마다 적어 두는 것 (사는 쪽). */
export interface BuyEntry {
  name?: string;
  /** 살 수 있었나 — 품절→구매가능 으로 **바뀌는 순간**을 잡으려고 적어 둔다. */
  buyable?: boolean;
  done?: boolean;
  opened?: boolean;
  stage?: Stage;
  blocked?: string;
  opened_at?: string;
  last_try_at?: string;
  lost_races?: number;
}

export interface State {
  items?: Record<string, ItemEntry>;
  buy?: Record<string, BuyEntry>;
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

/**
 * 쓰는 도중 죽어도 상태 파일이 깨지지 않게 임시 파일에 쓰고 바꿔치기한다.
 * **--dry-run 은 기록을 남기지 않는다** — 사지 않고 "샀을 것" 이라고만 한 판을 done 으로
 * 적어서 다음 진짜 감시가 그 상품을 건너뛰게 만든 적이 있다 (롯데온 판, 2026-09-26).
 */
export function saveState(path: string, state: State, dryRun: boolean): void {
  if (dryRun) return;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

export function buyEntry(state: State, code: string): BuyEntry {
  const all = (state.buy ??= {});
  return (all[code] ??= {});
}

/** 같은 말을 매 바퀴 하지 않으려고 센다. */
const SAID = new Set<string>();
function sayOnce(key: string, say: () => void): void {
  if (SAID.has(key)) return;
  SAID.add(key);
  say();
}

/** 지금 살 수 있는가. → [살 수 있나, 못 사는 이유] */
export function buyableNow(info: ItemInfo): [boolean, string] {
  if (!info.inStock) return [false, "품절"];
  if (info.possible === 0) return [false, `구매 한도를 다 썼습니다 (${info.limitText || "구매가능 0개"})`];
  return [true, ""];
}

/** 이번에 몇 개를 담을까. 상품 페이지가 말하는 한도를 넘기지 않는다. */
export function eaFor(target: BuyTarget, info: ItemInfo): number {
  const cap = info.possible ?? info.limit;
  if (cap && cap > 0 && target.ea > cap) {
    sayOnce(`cap:${target.code}:${cap}`, () =>
      log.warn(`[${target.code}] 수량 ${target.ea}개는 한도를 넘습니다 — ${cap}개로 갑니다 (${info.limitText || "구매 한도"})`));
    return cap;
  }
  return target.ea;
}

function onCooldown(stamp: string | undefined, minutes: number): number | null {
  if (!minutes || !stamp) return null;
  const elapsed = Date.now() - new Date(stamp).getTime();
  if (Number.isNaN(elapsed) || elapsed >= minutes * 60_000) return null;
  return Math.floor((minutes * 60_000 - elapsed) / 60_000) + 1;
}

function humanDuration(iso: string | undefined): string | null {
  if (!iso) return null;
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (Number.isNaN(s) || s < 0) return null;
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60}초`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
  return `${Math.floor(s / 86400)}일 ${Math.floor((s % 86400) / 3600)}시간`;
}

export interface BuyIO {
  /** 감시하는 창. 사는 탭도 여기에 연다. */
  watcher: Watcher;
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
  cfg: Config, discord: Discord, state: State, target: BuyTarget, info: ItemInfo, io: BuyIO,
): Promise<boolean> {
  const key = target.code;
  const entry = buyEntry(state, key);
  const name = target.label || info.name;
  entry.name = name;

  if (entry.done) {
    sayOnce(`done:${key}`, () => log.info(`[${key}] ${name} — 이미 샀습니다 (--reset 으로 지웁니다)`));
    return false;
  }
  const left = onCooldown(entry.last_try_at, cfg.buy.cooldownMinutes);
  if (left) {
    sayOnce(`cool:${key}`, () => log.warn(`[${key}] ${name} — 쉬는 중입니다. ${left}분 뒤에 다시 삽니다 (마지막 시도 ${entry.last_try_at})`));
    return false;
  }

  const was = entry.buyable;
  const [now, why] = buyableNow(info);
  entry.buyable = now;
  if (!now) {
    if (was) log.info(`[${key}] ${name} — 살 수 없게 바뀌었습니다 (${why})`);
    else if (info.inStock) sayOnce(`limit:${key}`, () => log.warn(`[${key}] ${name} — 팔고 있지만 ${why}`));
    delete entry.lost_races;
    return false;
  }

  // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다. 처음 본 것도 사지 않는다 — 설정을
  // 잘못 써 놓고 켰을 때 곧장 결제까지 가 버리는 사고가 여기서 막힌다.
  if (cfg.buy.buyOnRestockOnly && was !== false) {
    sayOnce(`hint:${key}`, () => {
      log.info(`[${key}] ${name} — 이미 판매 중입니다. 품절됐다가 다시 열릴 때 삽니다`);
      log.info(`   지금 사려면:  .\\gm --buy ${target.url}`);
    });
    return false;
  }

  // 로그인이 풀렸으면 구매하기를 눌러 봐야 로그인 화면으로 간다. **바뀌는 순간은 아껴 둔다** —
  // 살 수 없음으로 적어 두면, 다시 로그인한 뒤 첫 조회가 그대로 "바뀌는 순간" 이 된다.
  if (info.loggedIn === false) {
    entry.buyable = false;
    entry.blocked = SESSION_DEAD;
    sayOnce(`dead:${key}`, () => {
      log.error(`[${key}] ${name} — 열렸는데 로그인이 풀려 못 삽니다. .\\gm --login 을 하면 (감시는 그대로 두고) 곧장 삽니다`);
      void discord.buySession(cfg, `재입고됐는데 못 샀습니다: ${name}\n${target.url}`);
    });
    return false;
  }

  const limit = target.maxPrice || cfg.buy.maxPrice;
  if (limit && info.price && info.price > limit) {
    const reason = `가격이 상한을 넘습니다 — ${priceText(info.price)} > ${priceText(limit)}`;
    sayOnce(`price:${key}:${info.price}`, () => log.warn(`[${key}] 사지 않습니다 — ${reason}`));
    entry.blocked = reason;
    await discord.buyBlocked(cfg, target, reason);
    return false;
  }

  const ea = eaFor(target, info);
  log.info(`🟢 [${key}] ${name} — 구매 가능, 구매하기를 누릅니다 (×${ea}${target.option ? ` · ${target.option}` : ""})`);
  entry.last_try_at = new Date().toISOString();
  delete entry.blocked;

  const wait = cfg.buy.botCheckWaitSeconds;
  const got = await doBuy(cfg, io.watcher, target, ea, io.dumpPath, io.dryRun, {
    seconds: wait,
    notify: () => discord.botCheck(cfg, `사려는 순간 떴습니다: ${name}\n${target.url}`, wait),
  });
  entry.opened = got.ok;
  entry.stage = got.stage;

  if (got.dead) {
    // 상품 페이지는 로그인했다고 했는데 창에서 풀렸다. 세션 파일이 낡은 것이다.
    entry.blocked = SESSION_DEAD;
    entry.buyable = false;
    delete entry.last_try_at;
    log.error(`[${key}] 구매 창에서 로그인이 풀려 있었습니다 — .\\gm --login 으로 다시 로그인하세요`);
    await discord.buySession(cfg, `구매 창에서 로그인이 풀려 있었습니다: ${name}`);
    return false;
  }

  if (!got.ok && got.reason === BOT_CHECK_SAID) {
    // 사람이 확인을 마치지 않았다. 로그인 풀림과 같이 **바뀌는 순간을 아껴 두고** 쉬지 않는다 —
    // 사람이 뒤늦게라도 마치면 다음 조회가 곧 "바뀌는 순간" 이 된다.
    entry.blocked = BOT_CHECK_SAID;
    entry.buyable = false;
    delete entry.last_try_at;
    log.warn(`[${key}] ${BOT_CHECK_SAID} — 탭은 남겨 둡니다. 확인을 마치면 다음 조회에서 다시 삽니다`);
    return false;
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
  // 손댈 차례를 먼저 알린다. 결제 완료를 지켜보는 것은 그다음이다.
  if (!io.dryRun) await discord.buyOpened(cfg, target, info, got.stage, got.note);
  if (got.stage === "submitted" && got.buyer) await watchUntilPaid(cfg, discord, got.buyer, target, name);
  return true;
}

export interface WatchIO {
  statePath: string;
  dryRun: boolean;
  once: boolean;
  drop: boolean;
  signal: AbortSignal;
  /** 사는 데 필요한 것. null 이면 사지 않는다 (재입고 알림만). */
  buy: BuyIO | null;
}

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** 반환값이 종료 코드다. */
export async function watch(cfg: Config, watcher: Watcher, discord: Discord, io: WatchIO): Promise<number> {
  const codes = cfg.codes;
  const buying = new Map(io.buy ? cfg.buy.targets.map((t) => [t.code, t] as const) : []);
  // 봇 확인을 받을 때마다 두 배로 늦춘다 (최대 60초). 이번 실행 동안만이다.
  const pace = io.drop
    ? { interval: cfg.buy.dropIntervalSeconds, jitter: cfg.buy.dropJitterSeconds }
    : { interval: cfg.intervalSeconds, jitter: cfg.jitterSeconds };
  if (io.drop) log.warn("드랍 모드는 1초마다 봅니다. G마켓은 촘촘한 조회에 Cloudflare 봇 확인을 띄웁니다 — 드랍 직전에만 켜세요.");
  if (io.drop && buying.size && watcher.hidden) {
    log.warn("창 없이 돌고 있어 사는 순간 창을 다시 띄우느라 1~2초 늦습니다 — 드랍이면 --show 로 처음부터 창을 띄워 두세요.");
  }

  log.info(`G마켓 감시 시작 — 상품 ${codes.length}개, 주기 ${pace.interval}초(±${pace.jitter})` +
    (io.drop ? " · 드랍 모드: 재시도 쉼 없음, 상품 사이 쉼 없음" : ""));
  if (buying.size) {
    log.info(`🛒 구매 대상 ${buying.size}개 · 최대 ${cfg.buy.maxBuysPerRun}개 · ` +
      (cfg.buy.buyOnRestockOnly ? "품절 → 구매가능 으로 바뀔 때만 삽니다" : "재고가 있으면 바로 삽니다"));
    log.info(`🛒 ${arrivalLine(cfg)}`);
    for (const t of buying.values()) {
      log.info(`   [${t.code}] ${t.label || t.url} ×${t.ea}${t.option ? ` · 옵션 ${t.option}` : ""}${t.maxPrice ? ` · 상한 ${priceText(t.maxPrice)}` : ""}`);
    }
  } else if (cfg.buy.targets.length) {
    log.info("🛒 구매 대상이 있지만 이번 실행은 사지 않습니다 (--no-buy)");
  }

  const state = loadState(io.statePath);
  const items = (state.items ??= {});
  const fails = new Map<string, number>();
  let strikes = 0;
  let blockNotified = false;
  let sessionDead = false;
  let bought = 0;
  let sessionStamp = io.buy ? mtime(io.buy.sessionPath) : 0;
  let botStrikes = 0;
  const save = (): void => saveState(io.statePath, state, io.dryRun);

  while (!io.signal.aborted) {
    // 다른 창에서 --login 을 다시 했으면 새 쿠키를 얹는다. 감시를 껐다 켤 필요가 없다.
    if (io.buy) {
      const stamp = mtime(io.buy.sessionPath);
      if (stamp && stamp !== sessionStamp) {
        sessionStamp = stamp;
        log.info("🔑 세션 파일이 바뀌었습니다 — 새 로그인 쿠키를 얹습니다");
        await watcher.reloadSession().catch((e) => log.warn(`세션을 다시 읽지 못했습니다: ${(e as Error).message}`));
      }
    }

    let failed = false;
    let blocked: BlockedError | null = null;
    let botCheck: { code: string; error: BotCheckError } | null = null;
    for (const [i, code] of codes.entries()) {
      if (io.signal.aborted) break;
      if (i && !io.drop) await sleep(700 + Math.random() * 700, io.signal);

      let info: ItemInfo;
      try {
        info = await watcher.read(code, { quick: io.drop });
      } catch (e) {
        if (e instanceof BotCheckError) {
          botCheck = { code, error: e };
          break;
        }
        if (e instanceof BlockedError) {
          blocked = e;
          break;
        }
        failed = true;
        const n = (fails.get(code) ?? 0) + 1;
        fails.set(code, n);
        log.warn(`확인 실패 (${n}회 연속) ${(e as Error).message}`);
        if (n === cfg.errorNotifyAfter) await discord.alert("확인 실패", `https://item.gmarket.co.kr/Item?goodsCode=${code}\n\`\`\`${(e as Error).message}\`\`\``, Discord.gray);
        continue;
      }
      fails.delete(code);

      // --- 세션. 상품 페이지가 로그인한 사람에게 그려졌는지 매번 덤으로 본다. ---
      if (buying.size && info.loggedIn !== null) {
        if (!info.loggedIn && !sessionDead) {
          sessionDead = true;
          log.error("🔒 G마켓 로그인이 안 돼 있습니다 (세션이 없거나 풀렸습니다) — 재고가 열려도 못 삽니다. " +
            ".\\gm --login 으로 로그인하세요 (감시는 계속합니다)");
          await discord.buySession(cfg);
        } else if (info.loggedIn && sessionDead) {
          sessionDead = false;
          log.info("🔑 로그인이 돌아왔습니다");
        }
      }

      // --- 재입고 감시 (파이썬 판과 같은 판정) ---
      const stamp = new Date().toISOString();
      const entry = (items[code] ??= {});
      const before = entry.status;
      const status = info.inStock ? IN_STOCK : SOLDOUT;
      Object.assign(entry, { name: info.name, price: info.price, checked_at: stamp });
      const line = `${code}  ${statusText(info).padEnd(5)} ${priceText(info.price).padStart(10)}  ${info.name.slice(0, 50)}`;
      const target = buying.get(code);

      if (before === undefined) {
        Object.assign(entry, { status, since: stamp });
        log.info(`기준선 ${line}`);
      } else if (status === before) {
        log.info(line);
      } else if (status === IN_STOCK) {
        const outFor = humanDuration(entry.since);
        log.info(`🚨 재입고! ${line}`);
        Object.assign(entry, { status, since: stamp });
        if (onCooldown(entry.last_alert_at, cfg.alertCooldownMinutes)) {
          log.info("  (알림 쿨다운 중이라 알리지 않습니다)");
        } else {
          entry.last_alert_at = stamp;
          // 사는 상품이면 알림을 기다리지 않는다 — 웹훅 한 번이 0.2~0.5초다. 그 사이에 판다.
          const sending = discord.restock(cfg, info, outFor, !!target && !io.dryRun);
          if (!target) await sending;
        }
      } else {
        log.info(`품절 전환: ${line}`);
        Object.assign(entry, { status, since: stamp });
      }

      // --- 사기 ---
      if (target && io.buy) {
        try {
          if (await handleBuy(cfg, discord, state, target, info, io.buy)) bought++;
        } catch (e) {
          // 이 상품 하나의 일이다. **한 상품이 자빠졌다고 감시를 접지 않는다.**
          log.error(`[${code}] 사다가 끊겼습니다 — ${(e as Error).message}`);
          buyEntry(state, code).blocked = (e as Error).message;
        }
        save();
        if (bought >= cfg.buy.maxBuysPerRun) {
          log.info(`⭐ ${bought}개를 여기까지 데려왔습니다. 감시를 멈춥니다`);
          return 0;
        }
      }
    }

    // --- 봇 확인 — 두드리지 않는다. 알리고, 사람을 기다리고, 늦춘다. ---
    let penalty = 0;
    if (botCheck) {
      botStrikes++;
      const wait = cfg.buy.botCheckWaitSeconds;
      log.warn(`🤖 Cloudflare 봇 확인이 떴습니다 (${botStrikes}번째) — 감시 창에서 직접 확인을 마쳐 주세요 (최대 ${wait}초 기다립니다)`);
      if (botStrikes === 1 || botStrikes % 5 === 0) {
        await discord.botCheck(cfg, `감시 중에 떴습니다 (${botStrikes}번째).`, wait);
      }
      const passed = !io.dryRun && (await watcher.waitHuman(botCheck.code, wait, io.signal));
      if (pace.interval < 60) {
        pace.interval = Math.min(Math.max(pace.interval * 2, cfg.intervalSeconds), 60);
        log.warn(`주기를 ${pace.interval}초로 늦춥니다 (이번 실행 동안). 설정을 바꾸려면 item_interval_seconds`);
      }
      if (passed) {
        log.info("확인됐습니다 — 감시를 이어갑니다");
      } else {
        penalty = Math.min(300 * 2 ** (botStrikes - 1), 3600);
        log.warn(`확인이 안 됐습니다 — ${Math.round(penalty / 60)}분 물러났다가 다시 봅니다`);
      }
    }

    // --- 막혔을 때 — 1분 → 2 → 4 … 60분. 같은 속도로 계속 두드리면 일시 차단이 굳는다. ---
    if (blocked) {
      strikes++;
      penalty = Math.min(60 * 2 ** (strikes - 1), 3600);
      log.warn(`차단 (${strikes}회 연속) — ${penalty}초 물러납니다: ${blocked.message}`);
      if (!blockNotified) {
        blockNotified = true;
        await discord.alert("⛔ G마켓 상품 페이지 접근이 막혔습니다",
          `**${Math.round(penalty / 60)}분** 쉬었다가 다시 시도합니다.\n\`\`\`${blocked.message}\`\`\``);
      }
    } else if (strikes && !failed && !botCheck) {
      log.info(`접근 정상화 — 백오프 해제 (${strikes}회 만에)`);
      await discord.alert("✅ G마켓 상품 페이지 접근이 정상화되었습니다", "재입고 감시를 재개합니다.", Discord.green);
      strikes = 0;
      blockNotified = false;
    }

    save();
    if (io.once) return 0;

    // 드랍 모드여도 조회가 실패한 바퀴 뒤에는 한 번 평소 걸음으로 쉰다 (롯데온 판과 같다).
    const stumbled = failed || !!blocked || !!botCheck;
    const step = io.drop && stumbled ? { interval: Math.max(cfg.intervalSeconds, pace.interval), jitter: cfg.jitterSeconds } : pace;
    if (io.drop && stumbled) log.warn(`드랍 모드지만 조회가 실패해 이번만 ${step.interval}초 쉽니다`);
    const floor = io.drop ? 0.5 : 3;
    const wait = Math.max(floor, step.interval + (Math.random() * 2 - 1) * step.jitter) + penalty;
    await sleep(wait * 1000, io.signal);
  }

  save();
  log.info("종료합니다.");
  return 0;
}
