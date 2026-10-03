/** 한 번 부르고 끝나는 명령들. 지켜보는 것은 watch.ts 가 한다. (lotte-test/commands.ts 짜임) */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { log } from "../log.js";
import { CONFIG_PATH, editBuy, parseTarget, SESSION_PATH, type BuyTarget, type Config } from "./config.js";
import type { Discord } from "./discord.js";
import { doBuy, dumpHere, lastBuyer, watchUntilPaid } from "./order.js";
import { codeOf, priceText, statusText, urlFrom } from "./parse.js";
import { readOnce, Watcher } from "./session.js";
import { buyableNow, buyEntry, eaFor, loadState, saveState } from "./watch.js";

/**
 * 클립보드에 있는 것을 그대로 가져온다. (스마트스토어 판 ../commands.ts 와 같다)
 * 파워셸은 따옴표 없는 `&` 를 명령 구분자로 읽어 주소 꼬리를 자른다. 클립보드가 안전하다.
 */
export function clipboardText(): string {
  try {
    if (process.platform === "win32") {
      // 출력 인코딩을 못 박는다. 안 그러면 cp949 로 나와 값이 깨질 수 있다.
      return execFileSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw",
      ], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
    }
    const [cmd, args] = process.platform === "darwin" ? ["pbpaste", []] : ["xclip", ["-selection", "clipboard", "-o"]];
    return execFileSync(cmd, args as string[], { encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`클립보드를 읽지 못했습니다 (${(e as Error).message}). 값을 명령줄로 주세요.`);
  }
}

/** 주소든 번호든 받아 상품 주소로. 비어 있으면 클립보드에서 가져온다. */
export function urlOf(value: string): string {
  return urlFrom(value || clipboardText());
}

/** 설정의 구매 대상 중 이 상품의 것. 없으면 주소만으로 만든다(수량 1, 옵션 없음). */
export function targetFor(cfg: Config, url: string): BuyTarget {
  const code = codeOf(url);
  return cfg.buy.targets.find((t) => t.code === code) ?? parseTarget(url);
}

/** 살 상품을 설정의 buy.targets 에 넣는다. 이미 있는 것은 넣지 않는다. */
export function cmdAdd(values: string[]): number {
  let added = 0;
  editBuy((buy) => {
    const list: unknown[] = Array.isArray(buy.targets) ? buy.targets : (buy.targets = []);
    const have = new Set(list.map((one) => {
      try {
        return parseTarget(one).code;
      } catch {
        return "";
      }
    }));
    for (const value of values) {
      const t = parseTarget(urlFrom(value));
      if (have.has(t.code)) {
        log.info(`이미 있습니다: ${t.url}`);
        continue;
      }
      have.add(t.code);
      list.push(t.url);
      added++;
      log.info(`✅ 넣었습니다: ${t.url}`);
    }
  });
  if (added) {
    log.info(`${basename(CONFIG_PATH)} 의 buy.targets 에 ${added}개를 넣었습니다. ` +
      "수량(ea)·옵션(option)·상한가(max_price)는 파일에서 붙여 주세요.");
  }
  return 0;
}

/**
 * 스마일페이 비밀번호를 설정에 저장한다. 값 없이 부르면 클립보드, "clear" 면 지운다.
 * 파일에 평문으로 남는 것이 싫으면 GMARKET_PG_PASSWORD 환경변수로 넘긴다. **값은 로그에 적지 않는다.**
 */
export function cmdPin(value: string): number {
  if (value === "clear") {
    editBuy((buy) => delete buy.pg_password);
    log.info("스마일페이 비밀번호를 지웠습니다 — 이제 자판 앞에서 멈춥니다.");
    return 0;
  }
  const digits = (value || clipboardText()).replace(/\D/g, "");
  if (!digits) throw new Error("비밀번호를 알아보지 못했습니다. 숫자만 주세요.");
  editBuy((buy) => (buy.pg_password = digits));
  log.info(`스마일페이 비밀번호를 저장했습니다 (${digits.length}자리). submit 에서 **결제까지 끝납니다.** 지우려면 --pin clear`);
  return 0;
}

/** 대상 상품의 지금 재고. 세션이 있으면 실어서 읽는다 (로그인 여부·구매 한도가 같이 나온다). */
export async function cmdStatus(cfg: Config, codes: string[]): Promise<number> {
  const watcher = new Watcher(SESSION_PATH, { headless: cfg.buy.headless });
  let failed = 0;
  try {
    for (const code of codes) {
      try {
        const info = await readOnce(watcher, code, cfg.buy.botCheckWaitSeconds);
        console.log(`\n${info.inStock ? "🟢" : "🔴"} ${info.name}`);
        console.log(`   ${info.url}`);
        console.log(`   상태   ${statusText(info)}`);
        console.log(`   가격   ${priceText(info.price)}`);
        if (info.limitText) console.log(`   한도   ${info.limitText}`);
        const target = cfg.buy.targets.find((t) => t.code === code);
        if (target) console.log(`   구매   대상 ×${target.ea}${target.option ? ` · ${target.option}` : ""}${target.maxPrice ? ` · 상한 ${priceText(target.maxPrice)}` : ""}`);
        console.log(`   로그인 ${info.loggedIn === null ? "알 수 없음" : info.loggedIn ? "됨" : "안 됨"}`);
      } catch (e) {
        failed++;
        console.error(`\n⚠  조회 실패 — ${code}\n   ${(e as Error).message}`);
      }
    }
  } finally {
    await watcher.close();
  }
  return failed ? 1 : 0;
}

/**
 * 지금 바로 산다, order_action 이 정한 데까지.
 *
 * 사람이 직접 부른 명령이라 "품절→구매가능 으로 바뀔 때만" 규칙과 "이미 샀다" 기록을
 * 적용하지 않는다. 그 판단은 이미 사람이 한 것이다. 다만 품절이면 탭을 열지 않는다.
 *
 * 창(watcher)은 부른 쪽이 닫는다 — 사는 탭이 그 창에 있어서, 사람이 탭을 닫을 때까지 살려 둬야 한다.
 */
export async function cmdBuy(
  cfg: Config, discord: Discord, watcher: Watcher, paths: { state: string; dump: string }, url: string, alwaysDump: boolean,
): Promise<number> {
  const target = targetFor(cfg, url);
  const info = await readOnce(watcher, target.code, cfg.buy.botCheckWaitSeconds);
  log.info(`${info.name} — ${statusText(info)} (${priceText(info.price)}${info.limitText ? ` · ${info.limitText}` : ""})`);
  const [ok, why] = buyableNow(info);
  if (!ok) {
    log.error(`지금은 살 수 없습니다 — ${why}`);
    return 1;
  }
  if (info.loggedIn === false) {
    log.error("로그인이 안 된 세션입니다 — .\\gm --login 으로 먼저 로그인하세요.");
    return 1;
  }

  const state = loadState(paths.state);
  const entry = buyEntry(state, target.code);
  delete entry.done;

  const wait = cfg.buy.botCheckWaitSeconds;
  const got = await doBuy(cfg, watcher, target, eaFor(target, info), paths.dump, false, {
    seconds: wait,
    notify: () => discord.botCheck(cfg, `--buy 중에 떴습니다: ${info.name}\n${target.url}`, wait),
  });
  entry.opened = got.ok;
  entry.stage = got.stage;
  entry.last_try_at = new Date().toISOString();
  entry.done = got.ok && cfg.buy.stopAfterSuccess;
  if (got.ok) delete entry.blocked;
  else entry.blocked = got.reason ?? undefined;
  saveState(paths.state, state, false);

  if (got.dead) log.error("구매 창에서 로그인이 풀려 있었습니다 — .\\gm --login 으로 다시 로그인하세요.");
  else if (!got.ok) log.warn(`주문서까지 못 갔습니다 — ${got.reason}`);

  // --dump-pay 면 잘 갔든 아니든 받아 적는다. 그게 그 명령의 목적이다.
  if (alwaysDump) {
    const buyer = lastBuyer();
    if (buyer) await dumpHere(buyer, paths.dump);
    else log.warn("받아 적을 창이 없습니다.");
  }
  if (got.ok) {
    await discord.buyOpened(cfg, target, info, got.stage, got.note);
    if (got.stage === "submitted" && got.buyer) await watchUntilPaid(cfg, discord, got.buyer, target, target.label || info.name);
  }
  return got.ok ? 0 : 1;
}
