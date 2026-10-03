/**
 * **크롬 하나**를 띄워 두고 그 안에서 상품 페이지를 읽는다. 사는 탭도 같은 크롬에 연다.
 * 그리고 로그인 세션을 만들고 확인한다.
 *
 * G마켓 상품 페이지는 Node 의 fetch 를 막는다 (2026-09-26, 이 PC 에서 세 번 다 403). 그래서
 * 크롬을 띄워 item.gmarket.co.kr 의 가벼운 자리(robots.txt)에 탭 하나를 세워 두고 **그 페이지
 * 안에서 fetch 한다.** 한 번에 0.2~0.4초, HTML 한 장만 받는다. 같은 출처라 로그인 쿠키가 실리고,
 * 받아 온 HTML 의 IsLogin 으로 세션이 살아 있는지도 매번 덤으로 안다.
 *
 * **크롬은 puppeteer-extra + Stealth 로 띄운다 (launch.ts).** 기본은 창 없이(buy.headless).
 * Playwright 판은 창을 보이게 띄우고 UA 도 건드리지 않았다 — 창 없는 크롬이 Cloudflare 봇 확인에
 * 걸렸기 때문이다 (2026-09-26 밤). 이 판은 Stealth 로 흔적을 지우고 창 없이 간다.
 *
 * **그래도 사람이 봐야 하는 일은 창에서 한다.** 봇 확인이 뜨거나 사기 시작하면, 창 없이 돌던
 * 크롬을 쿠키째 들고 **보이는 창으로 다시 띄운다** (show). 한 번 띄우면 이번 실행 동안은 그대로다
 * — 사는 탭이 그 창에 남고, 봇 확인을 마친 표시(cf_clearance 쿠키)도 그 창에 있다.
 *
 * 봇 확인을 프로그램이 넘지는 않는다 — 확인 화면을 누르지 않는다. 로그인도 사람이 한다.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import type { Browser, CookieData, Page } from "puppeteer";
import { log, sleep } from "../log.js";
import { initBrowser, readCookies, saveCookies } from "./launch.js";
import { hasStock, itemUrl, looksLikeBotCheck, parseItem, type ItemInfo } from "./parse.js";
import { js } from "./press.js";

const PARK_URL = "https://item.gmarket.co.kr/robots.txt";
const BLOCK_STATUSES = new Set([403, 429, 503]);
const LOGIN_URL = "https://signinssl.gmarket.co.kr/login/login?url=https%3A%2F%2Fwww.gmarket.co.kr%2F";
const LOGIN_HOSTS = ["signinssl.gmarket.co.kr", "signin.gmarket.co.kr"];

/** G마켓이 요청을 막았다. 물러났다가 천천히 돌아와야 한다. */
export class BlockedError extends Error {
  override name = "BlockedError";
}

/** Cloudflare 가 봇 확인을 세웠다. 다시 두드리지 않는다 — 사람이 창에서 마쳐야 풀린다. */
export class BotCheckError extends Error {
  override name = "BotCheckError";
}

// 퍼피티어가 탭·크롬이 사라졌을 때 내는 말들.
const CLOSED_RE = /Target closed|Session closed|Connection closed|has been closed|detached|Execution context was destroyed/i;

// 페이지 안에서 받아 온다. 함수를 넘기면 tsx 가 이름표(__name)를 붙여 브라우저에서 터지는
// 일이 있어서(스마트스토어 판에서 겪었다) 문자열로 넘긴다.
const getSrc = (url: string): string => `(async () => {
  const r = await fetch(${JSON.stringify(url)}, { credentials: "include", cache: "no-store" });
  return [r.status, await r.text()];
})()`;

const LOGIN_STATE_SRC =
  "(function () { var h = window.GmarketHeaderComm; return h && h.Member ? String(h.Member.IsLogin) : null; })()";

const goto = (page: Page, url: string): Promise<unknown> =>
  page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);

export class Watcher {
  private browser: Browser | null = null;
  /** 세워 둔 감시 탭. 사는 탭은 이것과 따로 연다. */
  private page: Page | null = null;
  private headless: boolean;
  /** 창을 다시 띄울 때 들고 가는 쿠키. 세션 파일보다 새것이다 (봇 확인을 마친 표시도 든다). */
  private carry: CookieData[] = [];

  /**
   * @param sessionPath 없거나 파일이 없으면 로그인 없이 읽는다 (재고는 공개 정보다).
   * @param opts.headless 창 없이 시작할까. 사람이 봐야 하는 일이 생기면 창을 띄워 옮겨 간다.
   */
  constructor(private readonly sessionPath: string | null, opts: { headless?: boolean } = {}) {
    this.headless = opts.headless ?? false;
  }

  /** 지금 창 없이 돌고 있는가. */
  get hidden(): boolean {
    return this.headless;
  }

  /** 크롬이 떠 있게 한다. 새로 띄웠으면 세션 파일의 쿠키, 그 위에 들고 온 쿠키를 얹는다. */
  private async up(): Promise<Browser> {
    if (this.browser?.connected) return this.browser;
    await this.close();
    const { browser, page } = await initBrowser(this.headless);
    this.browser = browser;
    const cookies = [...readCookies(this.sessionPath), ...this.carry];
    if (cookies.length) await browser.setCookie(...cookies);
    this.park(page);
    return browser;
  }

  private park(page: Page): void {
    this.page = page;
    // 감시 탭에 alert 가 뜨면 (창이 없으면 특히) 아무도 못 닫고 모든 조회가 멈춘다. 닫는다.
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
  }

  private async tab(): Promise<Page> {
    const browser = await this.up();
    if (!this.page || this.page.isClosed()) this.park(await browser.newPage());
    return this.page!;
  }

  /**
   * 감시 탭을 item.gmarket.co.kr 에 세운다 — fetch 가 같은 출처여야 쿠키가 실린다. 쿠키를 얹은
   * **뒤에** 가야 한다. 사람이 탭을 딴 데로 옮겼으면 다시 세운다.
   */
  private async ensure(): Promise<Page> {
    const page = await this.tab();
    if (!page.url().startsWith("https://item.gmarket.co.kr/")) await goto(page, PARK_URL);
    return page;
  }

  /** 감시를 시작하기 전에 브라우저 문제를 미리 드러낸다. */
  async launch(): Promise<void> {
    await this.ensure();
  }

  /**
   * 사람이 봐야 하는 일이 생겼다. 창 없이 돌고 있었으면 **쿠키를 들고 보이는 창으로 다시 띄운다.**
   * 창 없는 크롬은 창으로 바꿀 수가 없어서 새로 띄운다 (1~2초). 감시 탭은 다음 조회 때 다시 세운다.
   */
  async show(why: string): Promise<void> {
    if (!this.headless) return;
    log.warn(`🪟 ${why} — 창을 띄워 옮겨 갑니다 (이번 실행 동안은 창을 둡니다)`);
    if (this.browser?.connected) this.carry = await this.browser.cookies().catch(() => this.carry);
    await this.close();
    this.headless = false;
    await this.up();
  }

  /**
   * 사는 탭을 같은 크롬(같은 쿠키)에 연다. 봇 확인을 한 번 마치면 감시와 구매가 같이 이어간다.
   * **사는 탭은 창에 연다** — 어디서 멈췄든 사람이 이어 누르고, 결제는 그 탭에서 끝난다.
   */
  async newTab(): Promise<Page> {
    await this.show("사는 탭은 사람이 볼 수 있어야 합니다");
    return (await this.up()).newPage();
  }

  isParked(page: Page): boolean {
    return page === this.page;
  }

  /** 세션 파일을 다시 읽어 쿠키를 얹는다. 창을 닫지 않는다 — 열려 있는 사는 탭이 있을 수 있다. */
  async reloadSession(): Promise<void> {
    if (!this.browser?.connected || !this.sessionPath || !existsSync(this.sessionPath)) return;
    const cookies = readCookies(this.sessionPath);
    if (cookies.length) await this.browser.setCookie(...cookies);
  }

  async close(): Promise<void> {
    const { browser } = this;
    this.browser = null;
    this.page = null;
    await browser?.close().catch(() => undefined);
  }

  private async get(url: string): Promise<[number, string]> {
    const page = await this.ensure();
    return js<[number, string]>(page, getSrc(url));
  }

  /**
   * 상품 하나. 집 IP 에서도 403 이 한 번씩 섞이므로 잠깐 쉬고 다시 해 본다 (파이썬 판과 같다).
   * 끝내 막히면 BlockedError. **봇 확인이면 곧장 BotCheckError** — 다시 두드려 봐야 같은 화면이고,
   * 두드리는 것 자체가 "봇의 동작" 으로 읽힌다.
   *
   * @param quick 드랍 모드 — 다시 해 보기 전에 오래 쉬지 않는다.
   */
  async read(code: string, opts: { tries?: number; quick?: boolean } = {}): Promise<ItemInfo> {
    const tries = opts.tries ?? 3;
    const url = itemUrl(code);
    let status = 0;
    let last = "";
    for (let n = 0; n < tries; n++) {
      let html = "";
      try {
        [status, html] = await this.get(url);
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0] ?? "";
        // 사람이 감시 탭을 닫았거나 크롬이 죽었으면 다음 시도에서 다시 세운다.
        if (CLOSED_RE.test(msg)) log.warn(`감시 탭이 닫혀 다시 엽니다: ${msg}`);
        last = msg;
      }
      if (status === 200 && hasStock(html)) return parseItem(code, html);
      if (html && looksLikeBotCheck(html)) throw new BotCheckError(`${code}: Cloudflare 봇 확인 (HTTP ${status})`);
      if (html) last = `HTTP ${status}` + (status === 200 ? " — 품절 정보(IsOutOfStock)가 없음" : "");
      if (n < tries - 1) await sleep(opts.quick ? 300 : 2000 + n * 2000 + Math.random() * 1000);
    }
    if (BLOCK_STATUSES.has(status)) throw new BlockedError(`${code}: ${tries}번 모두 막힘 (${last})`);
    throw new Error(`${code}: ${last}`);
  }

  /**
   * 봇 확인이 떴다. 감시 탭에 그 상품 페이지를 띄워 **사람이 직접 마치기를 기다린다.** → 마쳤으면 true
   * 창 없이 돌고 있었으면 먼저 창을 띄운다 — 창이 없으면 사람이 마칠 수가 없다.
   *
   * 프로그램은 확인 화면에서 아무것도 누르지 않는다. 확인이 끝나면 Cloudflare 가 상품 페이지로
   * 되돌려 보내고, 그 화면에 재고 표시가 보이면 마친 것으로 본다.
   */
  async waitHuman(code: string, seconds: number, signal?: AbortSignal): Promise<boolean> {
    await this.show("Cloudflare 봇 확인은 사람이 창에서 마쳐야 합니다");
    const page = await this.tab();
    await goto(page, itemUrl(code));
    await page.bringToFront().catch(() => undefined);
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until && !signal?.aborted) {
      if (page.isClosed()) return false;
      const html = await page.content().catch(() => "");
      if (html && !looksLikeBotCheck(html) && hasStock(html)) {
        await goto(page, PARK_URL);
        return true;
      }
      await sleep(1500, signal);
    }
    return false;
  }
}

/** 한 번 읽되, 봇 확인이면 사람을 기다렸다 한 번만 더 읽는다. 단발 명령(--status·--whoami·--buy)이 쓴다. */
export async function readOnce(watcher: Watcher, code: string, waitSeconds: number): Promise<ItemInfo> {
  try {
    return await watcher.read(code);
  } catch (e) {
    if (!(e instanceof BotCheckError)) throw e;
    log.warn(`🤖 Cloudflare 봇 확인이 떴습니다 — 뜬 크롬 창에서 직접 확인을 마쳐 주세요 (최대 ${waitSeconds}초 기다립니다)`);
    if (!(await watcher.waitHuman(code, waitSeconds))) throw new BotCheckError(`${e.message} — 확인을 마치지 않아 멈춥니다`);
    log.info("확인됐습니다 — 다시 읽습니다");
    return watcher.read(code);
  }
}

/**
 * 창을 띄워 사람이 직접 로그인하게 하고, 끝나면 세션(쿠키)만 저장한다. **로그인은 늘 창에서 한다.**
 *
 * **아이디·비밀번호를 넣지 않는다.** 로그인이 됐는지는 상품 페이지의 IsLogin 으로 본다 — 로그인 뒤
 * 돌아가는 메인(www.gmarket.co.kr)에는 그 표시가 없다(재 봤다). 그래서 사람이 로그인 화면을
 * **벗어난 뒤에** 확인용 탭을 하나 열어 상품 페이지를 받아 본다. 그래도 알아보지 못하면 사람이
 * 터미널에서 Enter 를 누를 때 저장한다.
 *
 * 처음 판은 확인용 탭을 처음부터 열었다가, 그 탭에 Cloudflare 봇 확인이 떠서 로그인을 끝내
 * 알아보지 못하고 세션도 못 남겼다 (2026-09-26). 그래서 로그인 화면을 벗어난 뒤에야 연다.
 */
export async function doLogin(sessionPath: string, probeCode: string, timeoutSec = 600): Promise<boolean> {
  console.log("크롬 창이 열립니다. 창 안에서 G마켓에 직접 로그인해 주세요 ('로그인 상태 유지' 를 켜 두면 오래 갑니다).");
  console.log("(이 프로그램은 아이디·비밀번호를 입력하거나 저장하지 않습니다. 로그인 쿠키만 저장합니다.)");
  console.log("로그인이 끝나면 저절로 저장합니다. 알아보지 못하면 여기서 Enter 를 누르세요 — 그때 저장합니다.");
  console.log(`제한 시간 ${Math.floor(timeoutSec / 60)}분\n`);

  const { browser, page } = await initBrowser(false);
  const rl = createInterface({ input: process.stdin });
  let entered = false;
  rl.on("line", () => (entered = true));
  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    let saidBot = false;
    let probe: Page | null = null;
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline && browser.connected) {
      let seen: string | null = null;
      const pages = await browser.pages().catch(() => [] as Page[]);
      const atLogin = (p: Page): boolean => LOGIN_HOSTS.some((h) => p.url().includes(h));
      const away = pages.some((p) => p !== probe && p.url().startsWith("http") && !atLogin(p));
      for (const p of pages) {
        if (p === probe || atLogin(p)) continue;
        seen = (await js<string | null>(p, LOGIN_STATE_SRC).catch(() => null)) ?? seen;
      }
      // 로그인 화면을 벗어났다. 상품 페이지 한 장으로 로그인됐는지 물어본다.
      if (seen !== "1" && away) {
        if (!probe || probe.isClosed()) {
          probe = await browser.newPage();
          await goto(probe, PARK_URL);
          await page.bringToFront().catch(() => undefined);
        }
        const [, html] = await js<[number, string]>(probe, getSrc(itemUrl(probeCode))).catch(() => [0, ""] as [number, string]);
        seen = /IsLogin\s*:\s*"(\d)"/.exec(html)?.[1] ?? seen;
        if (!saidBot && (looksLikeBotCheck(html) || looksLikeBotCheck(await probe.content().catch(() => "")))) {
          saidBot = true;
          console.log("확인용 탭에 봇 확인이 떴습니다 — 그 탭에서 직접 확인을 마치거나, 로그인이 끝났으면 여기서 Enter 를 누르세요.");
          await goto(probe, itemUrl(probeCode));
          await probe.bringToFront().catch(() => undefined);
        }
      }
      if (seen === "1" || entered) {
        const n = await saveCookies(browser, sessionPath);
        console.log(seen === "1" ? "로그인 확인. 세션을 저장했습니다." : "Enter — 세션을 저장했습니다 (로그인 여부는 --whoami 로 확인하세요).");
        console.log(`저장 위치: ${sessionPath} (쿠키 ${n}개)`);
        console.log("이 파일에는 G마켓 로그인 쿠키가 들어 있습니다. 남과 공유하지 마세요.");
        return true;
      }
      await sleep(away ? 3000 : 1500);
    }
  } finally {
    rl.close();
    await browser.close().catch(() => undefined);
  }
  console.error("로그인을 확인하지 못했습니다 (창이 닫혔거나 시간이 지났습니다).");
  return false;
}

/** 세션이 살아 있는지. 상품 페이지 한 장을 세션을 실어 받아 IsLogin 을 본다. → 종료 코드 */
export async function whoami(sessionPath: string, probeCode: string, waitSeconds: number, headless: boolean): Promise<number> {
  if (!existsSync(sessionPath)) {
    log.error(`로그인 세션이 없습니다: ${basename(sessionPath)} — 먼저 --login`);
    return 1;
  }
  const watcher = new Watcher(sessionPath, { headless });
  try {
    const info = await readOnce(watcher, probeCode, waitSeconds);
    if (info.loggedIn) {
      log.info("✅ 세션이 살아 있습니다 — 로그인된 상태입니다");
      if (info.limitText) log.info(`   (확인한 상품 ${info.code}: ${info.limitText})`);
      return 0;
    }
    log.error(info.loggedIn === false
      ? "세션이 끊겼습니다 (상품 페이지가 로그인 안 된 사람에게 그려졌습니다). --login 으로 다시 로그인하세요."
      : "로그인 여부를 상품 페이지에서 읽지 못했습니다 — 판정하지 않습니다");
    return 1;
  } finally {
    await watcher.close();
  }
}
