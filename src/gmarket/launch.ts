/**
 * 크롬을 띄운다 — puppeteer-extra + Stealth 플러그인. 그리고 로그인 쿠키를 싣고 내린다.
 *
 * Stealth 는 자동화 흔적(navigator.webdriver · HeadlessChrome UA · 빈 plugins …)을 지운다.
 * 언어만은 한국어로 고쳐 끼운다 — 그대로 두면 Accept-Language 와 navigator.languages 가
 * en-US 로 나가서, 한국 시간대·한국어 창과 어긋난다 (어긋나는 것 자체가 흔적이다).
 *
 * **봇 확인(Cloudflare Turnstile)을 넘는 일은 하지 않는다.** 흔적을 지워도 확인이 뜨면
 * 프로그램은 그 화면을 누르지 않는다 — 창을 띄워 사람이 마친다 (session.ts 의 show).
 *
 * 퍼피티어가 받아 둔 크롬(~/.cache/puppeteer)이 없으면 설치된 Google Chrome, 그다음 Edge 로
 * 대신 띄운다. 스마트스토어 판(../fetcher.ts 의 launchBrowser)과 같은 순서다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import NavigatorLanguages from "puppeteer-extra-plugin-stealth/evasions/navigator.languages/index.js";
import UserAgentOverride from "puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js";
import type { Browser, CookieData, LaunchOptions, Page } from "puppeteer";
import { log } from "../log.js";

// puppeteer-extra 는 CommonJS 다. 이 프로젝트(NodeNext)에서 기본 import 는 module.exports 통째로
// 잡혀 타입이 한 칸 밀린다. 런타임에도 .default 가 같은 것을 가리키므로 그걸 쓴다.
const puppeteer = puppeteerExtra.default;

// Stealth 플러그인 활성화 (자동화 흔적 제거). 언어를 정하는 둘만 빼서 한국어로 다시 끼운다.
const stealth = StealthPlugin();
stealth.enabledEvasions.delete("user-agent-override");
stealth.enabledEvasions.delete("navigator.languages");
puppeteer.use(stealth);
puppeteer.use(UserAgentOverride({ locale: "ko-KR,ko" }));
puppeteer.use(NavigatorLanguages({ languages: ["ko-KR", "ko"] }));

// Stealth 의 evasion 들은 탭이 열리자마자 CDP 로 스크립트를 심는다. 그 사이 탭이 닫히면(처음 빈 탭,
// 스스로 닫히는 결제 팝업, 창으로 다시 띄울 때) 두 가지가 생긴다. 가짜 페이지 시험에서 둘 다 겪었다.
//   - 몇몇 evasion 은 그 약속을 받지 않는다. 거절된 채 떠돌면 Node 는 **프로세스를 통째로 끝낸다** —
//     감시도, 결제 중인 탭도 같이 죽는다.
//   - puppeteer-extra 는 받은 것을 console.error 로 스택째 찍는다. 화면이 덮인다.
// 닫힌 탭 이야기만 파일 로그(DEBUG)로 돌리고, 나머지는 그대로 터뜨리고 그대로 찍는다.
const TAB_GONE_RE = /Target closed|Session closed|No target with given id|Connection closed/i;
const tabGone = (e: unknown): e is Error =>
  e instanceof Error && (e.name === "TargetCloseError" || TAB_GONE_RE.test(e.message));

process.on("unhandledRejection", (e) => {
  if (!tabGone(e)) throw e;
  log.debug(`닫힌 탭에 Stealth 가 스크립트를 심다 말았습니다 — 넘어갑니다 (${e.message.split("\n")[0]})`);
});
const printError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (args.length === 1 && tabGone(args[0])) {
    log.debug(`닫힌 탭에 Stealth 가 스크립트를 심다 말았습니다 — 넘어갑니다 (${args[0].message.split("\n")[0]})`);
    return;
  }
  printError(...args);
};

/** 크롬을 띄우지 못했다. G마켓과 무관한 이 PC 의 문제라 다시 해도 소용없다. */
export class BrowserError extends Error {
  override name = "BrowserError";
}

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const CHANNELS: { name: string; opts: LaunchOptions }[] = [
  { name: "퍼피티어 크롬", opts: {} },
  { name: "설치된 Google Chrome", opts: { channel: "chrome" } },
  ...(existsSync(EDGE) ? [{ name: "설치된 Microsoft Edge", opts: { executablePath: EDGE } }] : []),
];

/**
 * 크롬을 띄우고 탭 하나를 연다.
 *
 * @param headless 창 없이 띄울까. 사람이 봐야 하는 일(로그인·봇 확인·사기)은 창이 있어야 한다.
 *
 * 처음 뜨는 빈 탭은 닫고 **새 탭**을 쓴다 — Stealth 는 새로 여는 탭에 입혀지고, 처음 탭은 놓친다.
 * viewport 를 비워 둔다(창 크기 그대로). 창 없는 크롬은 창이 800x600 이라 그것도 흔적이다.
 */
export async function initBrowser(headless: boolean): Promise<{ browser: Browser; page: Page }> {
  log.debug(`🚀 Stealth 모드로 브라우저 실행 중... (${headless ? "창 없이" : "창을 띄워"})`);
  const args = ["--lang=ko-KR", ...(headless ? ["--window-size=1366,900"] : [])];
  const failures: string[] = [];
  for (const { name, opts } of CHANNELS) {
    let browser: Browser;
    try {
      browser = await puppeteer.launch({ headless, defaultViewport: null, args, ...opts });
    } catch (e) {
      failures.push(`${name}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
      continue;
    }
    if (opts !== CHANNELS[0]!.opts) log.warn(`퍼피티어 크롬을 찾지 못해 ${name} 로 실행합니다.`);
    const blank = await browser.pages();
    const page = await browser.newPage();
    await Promise.all(blank.map((p) => p.close().catch(() => undefined)));
    return { browser, page };
  }
  throw new BrowserError(
    ["크롬을 띄우지 못했습니다 (퍼피티어 크롬, Chrome, Edge 모두 실패)", ...failures.map((f) => "  - " + f.slice(0, 150))].join("\n") +
      "\n  해결: ts 폴더에서  npx puppeteer browsers install chrome  을 실행하거나, Google Chrome 을 설치하세요.",
  );
}

// ---------------------------------------------------------------------------
// 로그인 쿠키. 파일 꼴은 Playwright 의 storageState 와 같다 ({cookies, origins}) —
// Playwright 판이 만든 gmarket_session.json 을 그대로 읽고, 이 판이 쓴 것도 그쪽이 읽는다.
// ---------------------------------------------------------------------------

interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** 초. 세션 쿠키는 -1. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

const SAME_SITE = new Set(["Strict", "Lax", "None"]);

/**
 * 크롬에 넣을 꼴로. 아는 칸만 옮긴다 — 크롬이 돌려준 쿠키에는 size·session 따위가 붙어 있다.
 * **만료가 없는(-1) 쿠키는 만료를 빼고 넣는다.** -1 을 그대로 넣으면 이미 지난 쿠키가 된다.
 */
export function toCookieData(c: Partial<SavedCookie>): CookieData | null {
  if (!c.name || c.value === undefined || !c.domain) return null;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    ...(c.sameSite && SAME_SITE.has(c.sameSite) ? { sameSite: c.sameSite } : {}),
    ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}),
  };
}

/** 세션 파일의 쿠키. 파일이 없으면 빈 것. */
export function readCookies(path: string | null): CookieData[] {
  if (!path || !existsSync(path)) return [];
  const state = JSON.parse(readFileSync(path, "utf8").replace(/^\u{FEFF}/u, "")) as { cookies?: Partial<SavedCookie>[] };
  return (state.cookies ?? []).map(toCookieData).filter((c): c is CookieData => !!c);
}

/** 크롬의 쿠키를 세션 파일로. → 적은 수 */
export async function saveCookies(browser: Browser, path: string): Promise<number> {
  const cookies: SavedCookie[] = (await browser.cookies()).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.session ? -1 : c.expires,
    httpOnly: !!c.httpOnly,
    secure: c.secure,
    ...(c.sameSite && SAME_SITE.has(c.sameSite) ? { sameSite: c.sameSite as SavedCookie["sameSite"] } : {}),
  }));
  writeFileSync(path, JSON.stringify({ cookies, origins: [] }, null, 2), "utf8");
  return cookies.length;
}
