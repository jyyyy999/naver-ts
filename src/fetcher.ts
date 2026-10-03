import { existsSync } from "node:fs";
import { basename } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { log } from "./log.js";

// 브라우저 컨텍스트와 쿠키를 만든 브라우저의 UA 가 다르면 세션이 더 빨리 풀린다.
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LOGIN_HOST = "nid.naver.com";
const CAPTCHA_STATUS = 490;
const BLOCK_STATUSES = new Set([429, 403, 490, 503]);

/** 저장된 세션이 없거나 만료됐다. */
export class LoginRequired extends Error {
  override name = "LoginRequired";
}

/** 브라우저를 띄우지 못했다. 네이버와 무관한 환경 문제라 재시도해도 소용없다. */
export class BrowserError extends Error {
  override name = "BrowserError";
}

/** 네이버가 요청을 막았다. 물러났다가 천천히 돌아와야 한다. */
export class BlockedError extends Error {
  override name = "BlockedError";
}

const CHANNELS = [
  { channel: undefined, name: "번들 Chromium" },
  { channel: "chrome", name: "설치된 Google Chrome" },
  { channel: "msedge", name: "설치된 Microsoft Edge" },
] as const;

/**
 * 브라우저를 띄운다. 번들 Chromium 이 없으면 설치된 Chrome, 그다음 Edge 로 대신 띄운다.
 * `npx playwright install` 은 cdn.playwright.dev 에서 받아야 하는데, 그게 막힌 환경에서는
 * 설치 자체가 안 된다. Windows 11 에는 Edge 가 항상 있으므로 이 폴백이 사실상 마지막 보루다.
 */
export async function launchBrowser(headless: boolean): Promise<Browser> {
  const failures: string[] = [];
  for (const { channel, name } of CHANNELS) {
    try {
      const browser = await chromium.launch({ headless, ...(channel ? { channel } : {}) });
      if (channel) log.warn(`번들 Chromium 을 찾지 못해 ${name} 로 실행합니다.`);
      return browser;
    } catch (e) {
      failures.push(`${name}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
    }
  }
  throw new BrowserError(
    ["브라우저를 실행하지 못했습니다 (번들 Chromium, Chrome, Edge 모두 실패)", ...failures.map((f) => "  - " + f.slice(0, 150))].join("\n") +
      "\n  해결: ts 폴더에서  npx playwright install chromium  을 실행하거나, Google Chrome 또는 Microsoft Edge 를 설치하세요.",
  );
}

const relogin = (): string => "  npm start -- --login  으로 다시 로그인하세요.";

/**
 * 저장된 로그인 세션으로 페이지의 __PRELOADED_STATE__ 를 읽는다.
 *
 * Node 의 fetch 는 brand.naver.com 도 429 로 막힌다 (Chrome TLS 지문이 없어서).
 * curl_cffi 같은 지문 흉내가 Node 에는 없으므로 모든 호스트를 브라우저로 읽는다.
 *
 * 리소스를 차단하면 안 된다. 이미지·CSS 만 막아도 smartstore 는 429 를 준다.
 * 대신 domcontentloaded 시점에 상태를 읽고 페이지를 곧바로 닫는다.
 * 상태는 서버 렌더링이라 그 시점에 이미 들어 있고, 이후의 하이드레이션 XHR
 * (앱 호스트로 50여 건)은 아예 발생하지 않는다 → 조회 1회당 앱 호스트 요청 1건.
 */
export class Fetcher {
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;

  constructor(
    private readonly sessionPath: string,
    private readonly headful = false,
  ) {}

  private async ensure(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    if (!existsSync(this.sessionPath)) {
      throw new LoginRequired(`로그인 세션이 없습니다: ${basename(this.sessionPath)}\n${relogin()}`);
    }
    this.browser = await launchBrowser(!this.headful);
    try {
      this.ctx = await this.browser.newContext({
        storageState: this.sessionPath,
        locale: "ko-KR",
        userAgent: UA,
        viewport: { width: 1440, height: 900 },
      });
    } catch (e) {
      await this.close();
      throw new LoginRequired(`세션 파일을 읽지 못했습니다 (${basename(this.sessionPath)}): ${String(e)}\n${relogin()}`);
    }
    return this.ctx;
  }

  /** 감시를 시작하기 전에 세션·브라우저 문제를 미리 드러낸다. */
  async launch(): Promise<void> {
    await this.ensure();
  }

  async close(): Promise<void> {
    const { ctx, browser } = this;
    this.ctx = this.browser = null;
    await ctx?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async state(url: string): Promise<any> {
    try {
      return await this.read(url);
    } catch (e) {
      // 브라우저 프로세스가 죽었으면 한 번만 다시 띄워 재시도한다
      if (e instanceof Error && /has been closed|Target closed|browser.*(disconnected|crash)/i.test(e.message)) {
        log.warn(`브라우저가 종료돼 다시 띄웁니다: ${e.message.split("\n")[0]}`);
        await this.close();
        return await this.read(url);
      }
      throw e;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async read(url: string): Promise<any> {
    const ctx = await this.ensure();
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const status = resp?.status() ?? null;

      if (page.url().includes(LOGIN_HOST)) {
        throw new LoginRequired(`세션이 만료됐습니다 (네이버 로그인 페이지로 넘어갔습니다).\n${relogin()}`);
      }

      const raw = await page.evaluate<string | null>(
        "window.__PRELOADED_STATE__ ? JSON.stringify(window.__PRELOADED_STATE__) : null",
      );
      if (raw) return JSON.parse(raw);

      // 차단당하면 에러 페이지가 200 이 아닌 상태코드로 온다.
      // 이걸 '구조 변경' 으로 뭉뚱그리면 백오프가 안 걸려 막힌 문을 계속 두드리게 된다.
      if (status === CAPTCHA_STATUS) throw new BlockedError(`HTTP ${status} — 캡차를 요구합니다`);
      if (status !== null && BLOCK_STATUSES.has(status)) throw new BlockedError(`HTTP ${status} — 네이버가 요청을 막았습니다`);
      throw new Error(`__PRELOADED_STATE__ 가 없습니다 (HTTP ${status}, 페이지 구조 변경 또는 삭제됨).`);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/** 브라우저 창을 띄워 사용자가 직접 로그인하게 하고, 끝나면 쿠키만 저장한다. */
export async function doLogin(sessionPath: string, timeoutSec = 300): Promise<boolean> {
  console.log("브라우저 창이 열립니다. 창 안에서 네이버에 직접 로그인해 주세요.");
  console.log("(이 스크립트는 아이디·비밀번호를 입력하거나 저장하지 않습니다. 로그인 쿠키만 저장합니다.)");
  console.log(`제한 시간 ${Math.floor(timeoutSec / 60)}분\n`);

  const browser = await launchBrowser(false);
  try {
    const ctx = await browser.newContext({ locale: "ko-KR", userAgent: UA, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("https://nid.naver.com/nidlogin.login?url=https%3A%2F%2Fsmartstore.naver.com%2F", {
      waitUntil: "domcontentloaded",
    });

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      let names: Set<string>;
      try {
        names = new Set((await ctx.cookies()).map((c) => c.name));
      } catch {
        break; // 사용자가 창을 닫음
      }
      // NID_AUT + NID_SES 두 개가 같이 있어야 실제 로그인 상태다
      if (names.has("NID_AUT") && names.has("NID_SES")) {
        console.log("로그인 확인. 세션을 저장합니다...");
        await ctx.storageState({ path: sessionPath });
        console.log(`저장 완료: ${sessionPath}`);
        console.log("이 파일에는 네이버 로그인 쿠키가 들어 있습니다. 남과 공유하지 마세요.");
        return true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  console.error("로그인을 확인하지 못했습니다.");
  return false;
}
