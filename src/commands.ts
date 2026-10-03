/** 한 번 부르고 끝나는 구매 쪽 명령들. 지켜보는 것은 watch.ts 가 한다. (lotte-test/commands.ts 짜임) */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { LOGIN_HOST } from "./browser.js";
import { editBuy, parseTarget } from "./config.js";
import type { Discord } from "./discord.js";
import { Fetcher, LoginRequired } from "./fetcher.js";
import { log } from "./log.js";
import { doBuy, dumpHere, lastBuyer, watchUntilPaid } from "./order.js";
import { label, lookup, parseProductUrl, priceText, stockText } from "./parse.js";
import type { BuyTarget, Config } from "./types.js";
import { buyableNow, buyEntry, loadState, saveState } from "./watch.js";

/**
 * 클립보드에 있는 것을 그대로 가져온다.
 *
 * 파워셸은 따옴표 없는 세미콜론·앰퍼샌드를 명령 구분자로 읽는다. 상품 주소 꼬리의
 * `&` 도 그렇게 잘린다. 그래서 명령줄보다 클립보드가 안전하다.
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

/** 설정의 구매 대상 중 이 주소의 것. 없으면 주소만으로 만든다(수량 1, 옵션 없음). */
export function targetFor(cfg: Config, url: string): BuyTarget {
  const { productId } = parseProductUrl(url);
  return cfg.buy.targets.find((t) => t.productId === productId) ?? parseTarget(url);
}

/** 복사해 둔 것 중에서 상품 주소만 골라낸다. */
export function urlFrom(value: string): string {
  const raw = value || clipboardText();
  const m = /https?:\/\/(?:brand|smartstore)\.naver\.com\/[^/\s]+\/products\/\d+/.exec(raw);
  if (!m) throw new Error(`상품 주소를 알아보지 못했습니다: ${raw.slice(0, 80)}`);
  return m[0];
}

// 로그인해야 볼 수 있는 자리. 살아 있는지 물어보는 데만 쓴다 (aio 네이버 판과 같은 곳).
const LOGIN_CHECK_URL = "https://nid.naver.com/user2/help/myInfoV2?lang=ko_KR";

/**
 * 세션 파일의 로그인이 살아 있는지. 신분은 NID_AUT·NID_SES 가 진다.
 *
 * 로그인 확인 주소는 Node 의 요청도 받아 준다(aio 네이버 판에서 확인). 막히는 것은
 * 상품 페이지 쪽이다.
 */
export async function cmdWhoami(sessionPath: string): Promise<number> {
  if (!existsSync(sessionPath)) {
    log.error(`로그인 세션이 없습니다: ${basename(sessionPath)} — npm start -- --login`);
    return 1;
  }
  type Cookie = { name: string; value: string; domain: string; expires: number };
  const cookies = ((JSON.parse(readFileSync(sessionPath, "utf8")) as { cookies?: Cookie[] }).cookies ?? [])
    .filter((c) => c.domain.endsWith("naver.com"));
  for (const name of ["NID_AUT", "NID_SES"]) {
    const c = cookies.find((one) => one.name === name);
    if (!c) {
      log.error(`${name} 쿠키가 없습니다 — 로그인이 안 된 세션입니다. npm start -- --login`);
      return 1;
    }
    const until = c.expires > 0 ? new Date(c.expires * 1000).toLocaleString("sv-SE") : "브라우저 닫을 때까지";
    log.info(`${name} 있음 (만료 ${until})`);
  }

  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  let res: Response;
  try {
    res = await fetch(LOGIN_CHECK_URL, {
      method: "HEAD", headers: { Cookie: header }, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    log.warn(`로그인 상태를 물어보지 못했습니다: ${(e as Error).message}`);
    return 1;
  }
  const where = res.headers.get("location") || "";
  if (res.status === 200) {
    log.info("✅ 세션이 살아 있습니다 — 로그인된 상태입니다");
    return 0;
  }
  if (res.status >= 300 && res.status < 400 && where.includes(LOGIN_HOST)) {
    log.error("세션이 끊겼습니다. npm start -- --login 으로 다시 로그인하세요.");
    return 1;
  }
  log.warn(`로그인 확인이 ${res.status} 로 답했습니다 (${where.slice(0, 60) || "이동 없음"}) — 판정하지 않습니다`);
  return 1;
}

/** 살 상품을 설정의 buy.targets 에 넣는다. 이미 있는 것은 넣지 않는다. */
export function cmdAdd(configPath: string, urls: string[]): number {
  let added = 0;
  editBuy(configPath, (buy) => {
    const list: unknown[] = Array.isArray(buy.targets) ? buy.targets : (buy.targets = []);
    const have = new Set(list.map((one) => {
      try {
        return parseTarget(one).productId;
      } catch {
        return "";
      }
    }));
    for (const url of urls) {
      const t = parseTarget(url);
      if (have.has(t.productId)) {
        log.info(`이미 있습니다: ${t.url}`);
        continue;
      }
      have.add(t.productId);
      list.push(t.url);
      added++;
      log.info(`✅ 넣었습니다: ${t.url}`);
    }
  });
  if (added) log.info(`${basename(configPath)} 의 buy.targets 에 ${added}개를 넣었습니다. 수량(ea)·옵션(option)·상한가(max_price)는 파일에서 붙여 주세요.`);
  return 0;
}

/**
 * 간편결제 비밀번호를 설정에 저장한다. 값 없이 부르면 클립보드, "clear" 면 지운다.
 * 파일에 평문으로 남는 것이 싫으면 NAVER_PG_PASSWORD 환경변수로 넘긴다. **값은 로그에 적지 않는다.**
 */
export function cmdPin(configPath: string, value: string): number {
  if (value === "clear") {
    editBuy(configPath, (buy) => delete buy.pg_password);
    log.info("간편결제 비밀번호를 지웠습니다 — 이제 인증 화면 앞에서 멈춥니다.");
    return 0;
  }
  const digits = (value || clipboardText()).replace(/\D/g, "");
  if (!digits) throw new Error("비밀번호를 알아보지 못했습니다. 숫자만 주세요.");
  editBuy(configPath, (buy) => (buy.pg_password = digits));
  log.info(`간편결제 비밀번호를 저장했습니다 (${digits.length}자리). submit 에서 **결제까지 끝납니다.** 지우려면 --pin clear`);
  return 0;
}

/**
 * 지금 바로 산다, order_action 이 정한 데까지.
 *
 * 사람이 직접 부른 명령이라 "품절→구매가능 으로 바뀔 때만" 규칙과 "이미 샀다" 기록을
 * 적용하지 않는다. 그 판단은 이미 사람이 한 것이다. 다만 품절이면 창을 띄우지 않는다.
 */
export async function cmdBuy(
  cfg: Config, discord: Discord,
  paths: { session: string; state: string; dump: string },
  url: string, alwaysDump: boolean,
): Promise<number> {
  const target = targetFor(cfg, url);
  const fetcher = new Fetcher(paths.session);
  let info;
  try {
    info = lookup(target.url, await fetcher.state(target.url));
  } finally {
    await fetcher.close();
  }
  log.info(`${info.name} — ${label(info.status)} (재고 ${stockText(info.stock)}, ${priceText(info.discounted ?? info.price)})`);
  const [ok, why] = buyableNow(info, target);
  if (!ok) {
    log.error(`지금은 살 수 없습니다 — ${why}`);
    return 1;
  }

  const state = loadState(paths.state);
  const entry = buyEntry(state, target.productId);
  delete entry.done;

  const got = await doBuy(cfg, paths.session, target, paths.dump);
  entry.opened = got.ok;
  entry.stage = got.stage;
  entry.last_try_at = new Date().toISOString();
  entry.done = got.ok && cfg.buy.stopAfterSuccess;
  if (got.ok) delete entry.blocked;
  else entry.blocked = got.reason ?? undefined;
  saveState(paths.state, state, false);

  if (got.dead) throw new LoginRequired("구매 창이 네이버 로그인 페이지로 넘어갔습니다.\n  npm start -- --login  으로 다시 로그인하세요.");
  if (!got.ok) log.warn(`주문서까지 못 갔습니다 — ${got.reason}`);

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
