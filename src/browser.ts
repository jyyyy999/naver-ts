/**
 * 네이버 상품 페이지를 **창을 띄운** 브라우저로 열어 구매하기까지 누른다.
 *
 *   새 창(로그인 세션 그대로) → 상품 페이지 → [옵션] → 구매하기
 *   → 구매 레이어([수량] → 바로구매) → 주문서 도착 확인 → [결제하기] → 인증 화면
 *
 * aio/node/src/naver/browser.ts (셀레니움) 를 Playwright 로 옮긴 것이다. 거기서 실제
 * 주문서까지 가 보며 맞춘 글자·주소·버튼 모양을 그대로 가져왔다 — 다시 짐작하지 않는다.
 *
 * 감시(fetcher.ts)는 창 없는 브라우저로 상태 JSON 만 읽고 곧바로 닫는다. 사는 일은 그것과
 * 따로 **창을 띄운** 브라우저로 한다. 네이버는 창 없이 연 상품 페이지에 "현재 서비스 접속이
 * 불가합니다" 를 준다(셀레니움 판에서 확인했다). 그리고 결제는 결국 사람이 보는 창에서
 * 끝나야 한다.
 *
 * 누를 것을 고르는 일은 페이지 안의 자바스크립트가 하고(글자로 찾기), 누르는 일은
 * Playwright 가 한다. 찾은 것에 `data-nts-*` 표시를 달아 두고 그 표시로 누른다 —
 * 자바스크립트로 부른 click 은 isTrusted 가 false 라 **창을 여는 버튼이면 크롬이 막는다.**
 *
 * 봇 탐지를 속이는 옵션은 쓰지 않는다. 로그인도 결제 확정도 사람이 한 것이다.
 */
import { writeFileSync } from "node:fs";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchBrowser, UA } from "./fetcher.js";
import { log, sleep } from "./log.js";
import { KEYPAD_SRC } from "./pin.js";
import { HELPERS_JS, pressMarked, type Pressed } from "./press.js";

export type { Pressed };

export const LOGIN_HOST = "nid.naver.com";
export const SESSION_DEAD = "로그인 세션이 끊겼습니다";

// 주문서에 도착했다는 증거. 셀레니움 판에서 실제로 도착한 곳은 이랬다.
//   https://orders.pay.naver.com/ordersheet/seller/eff61f5d-…
const ORDER_HOSTS = ["orders.pay.naver.com", "pay.naver.com"];
// 그 화면에 있던 글자들. "주문서" 가 아니라 슬래시가 낀 "주문/결제" 다.
const ORDER_MARKS = ["주문/결제", "주문상품", "배송지", "결제수단"];

// 상품 페이지의 구매 버튼. 누르면 **주문서로 바로 가지 않고 레이어가 뜬다.**
export const BUY_TEXTS = ["구매하기", "바로구매", "바로 구매"];
// 그 레이어. 수량도 여기서 정한다. **장바구니를 누르면 안 된다** — 담기고 주문서는 안 열린다.
const LAYER_MARKS = ["상품 구매 옵션", "수량 선택"];
const LAYER_CONFIRM = ["바로구매", "바로 구매", "구매하기"];
const OPTION_OPENERS = ["옵션 선택", "옵션선택", "선택하세요"];

// 캡차 벽. 창을 띄운 크롬에서도 온다. 버튼을 못 찾은 게 아니라 애초에 상품 페이지가 아니다.
const CAPTCHA_MARKS = ['title="captcha"', "wtm_captcha", "ncpt.naver.com"];
export const CAPTCHA_SAID = "네이버가 캡차를 세웠습니다 — 뜬 창에서 직접 풀어 주세요";
// 상품 페이지 대신 오는 오류 화면. 사람이 풀 것이 없고, 잠시 뒤 다시 받으면 된다.
const ERROR_PAGE_MARKS = ["에러페이지", "시스템오류"];
export const ERROR_PAGE_SAID = "네이버가 상품 페이지 대신 오류 화면(시스템오류)을 줍니다";

/** 창을 띄우지 못했다. 사는 일만 못 하는 것이지 감시를 접을 일은 아니다. */
export class BuyBrowserError extends Error {
  override name = "BuyBrowserError";
}

// ---------------------------------------------------------------------------
// 페이지 안에서 돌리는 조각들. tsx 가 함수에 이름표(__name)를 붙여 브라우저에서 터지는
// 일이 있어서 함수를 넘기지 않고 **문자열**로 넘긴다.
// ---------------------------------------------------------------------------

const SIG_SRC = `(function () { ${HELPERS_JS} return sig(); })()`;

// 글자로 눌러야 할 것을 찾아 data-nts-hit 표시를 단다. 셀레니움 판의 FIND_TEXT_JS 다.
// → null(못 찾음) | {status: "already"|"found", sig, what}
const FIND_TEXT_SRC = `(function (want) {
${HELPERS_JS}
Array.prototype.slice.call(document.querySelectorAll("[data-nts-hit]")).forEach(function (el) {
  el.removeAttribute("data-nts-hit");
});
function handles(el) {
  var tag = el.tagName;
  if (tag === "A" || tag === "BUTTON" || tag === "LABEL" || tag === "INPUT") return true;
  if (el.onclick || el.getAttribute("onclick") || el.getAttribute("href")) return true;
  if (el.getAttribute("role") === "button") return true;
  return false;
}
// 위로 올라가되 끝없이 올라가지는 않는다. 글자가 훨씬 많아지는 조상은 딴 것이다.
var CLIMB_LIMIT = want.length + 30;
function resolve(el) {
  if (handles(el)) return el;
  for (var up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    if (label(up).length > CLIMB_LIMIT) break;
    if (handles(up)) return up;
  }
  var inner = Array.prototype.slice.call(el.querySelectorAll("a, button, input")).filter(visible);
  return inner.length === 1 ? inner[0] : null;
}
var hits = [];
Array.prototype.slice.call(document.querySelectorAll("*")).forEach(function (el) {
  if (!visible(el)) return;
  var text = label(el);
  if (text.indexOf(want) === -1) return;
  var deeper = Array.prototype.slice.call(el.querySelectorAll("*")).some(function (kid) {
    return visible(kid) && label(kid).indexOf(want) !== -1;
  });
  if (deeper) return;
  hits.push({ el: el, text: text, target: resolve(el) });
});
if (!hits.length) return null;
// 문서 순서로 첫 번째를 집지 않는다 — 누를 수 있는 것, 글자가 딱 맞는 것, 짧은 것 먼저.
hits.sort(function (a, b) {
  if (!!a.target !== !!b.target) return a.target ? -1 : 1;
  var ax = a.text === want, bx = b.text === want;
  if (ax !== bx) return ax ? -1 : 1;
  return a.text.length - b.text.length;
});
var best = hits[0];
var target = best.target || best.el;
var box = null;
if (target.tagName === "LABEL") {
  if (target.htmlFor) box = document.getElementById(target.htmlFor);
  if (!box) box = target.querySelector('input[type="checkbox"], input[type="radio"]');
  if (box) target = box;
}
if (best.text !== want && !(best.target && best.text.length <= want.length + 10) && !box) return null;
if (target.disabled || target.getAttribute("aria-disabled") === "true" ||
    (target.classList && target.classList.contains("disabled"))) return null;
function describe(el) {
  var cls = el.className && el.className.baseVal === undefined ? String(el.className).trim() : "";
  return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
         (cls ? "." + cls.split(/\\s+/).join(".") : "") + ' "' + label(el).slice(0, 30) + '"';
}
if ((target.type === "checkbox" || target.type === "radio") && target.checked) {
  return { status: "already", sig: "", what: describe(target) };
}
target.setAttribute("data-nts-hit", "1");
return { status: "found", sig: sig(), what: describe(target) };
})`;

// 주문서 맨 아래의 결제 버튼. 금액이 숫자 롤러라 글자가 딱 맞게 찾는 방법으로는 못 찾는다
// (셀레니움 판에서 세 번 못 찾았다). 누를 수 있는 것 중 "결제하기" 를 품은 것을 고른다.
//   <button class="SubmitButton_button-pay__vMblX"> … 13100원 결제하기
const PAY_TEXT = "결제하기";
const PAY_CLASS = "button-pay"; // 뒤의 해시(__vMblX)는 배포마다 바뀐다.
const PAY_FIND_SRC = `(function (want, cls) {
${HELPERS_JS}
Array.prototype.slice.call(document.querySelectorAll("[data-nts-pay]")).forEach(function (el) {
  el.removeAttribute("data-nts-pay");
});
var hits = [];
Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
  .forEach(function (el) {
    if (!visible(el) || el.disabled === true) return;
    var text = ((el.textContent || "") + " " + (el.value || "")).replace(/\\s+/g, " ").trim();
    if (text.indexOf(want) === -1) return;
    hits.push({ el: el, text: text, named: ((el.className || "") + "").indexOf(cls) !== -1 });
  });
if (!hits.length) return null;
hits.sort(function (a, b) {
  if (a.named !== b.named) return a.named ? -1 : 1;
  return a.text.length - b.text.length;
});
hits[0].el.setAttribute("data-nts-pay", "1");
return { label: hits[0].text.slice(-24), named: hits[0].named, count: hits.length };
})`;

// 비밀번호 뒤 마지막 확인 화면에서 누를 것을 찾아 data-nts-fin 표시를 단다.
// extension/content.js 의 findTarget 과 같은 기준이다 — **누를 수 있는 것만**(button·a·label·
// 체크박스…) 보고, 비활성은 건너뛰고, 글자가 딱 맞는 것·짧은 것 먼저.
//
// 두 가지를 더 조였다.
//   exact  글자가 **딱 그것**인 것만 (마지막 "결제" 에 쓴다). 2026-08-17 bnkr 판에서 "결제" 를
//          느슨하게 찾다가 단계 목록(ol.steps "1. 이용약관에 동의하셨습니다 …")을 누른 적이 있다.
//   라벨   체크박스에 붙은 라벨은 문장이어도 된다 ("결제내용에 동의하시면 '결제' 버튼을 눌러
//          구매완료합니다."). 체크박스가 숨어 있으면 보이는 라벨을 누른다 — 라벨을 누르면 체크된다.
// → null(못 찾음) | {already: 이미 체크됨, box: 체크박스인가, text}
const FINISH_FIND_SRC = `(function (want, exact) {
${HELPERS_JS}
Array.prototype.slice.call(document.querySelectorAll("[data-nts-fin]")).forEach(function (el) {
  el.removeAttribute("data-nts-fin");
});
var CLICKABLE = 'button, a, label, [role="button"], [role="radio"], [role="checkbox"], ' +
  'input[type="submit"], input[type="button"], input[type="radio"], input[type="checkbox"]';
function text(el) {
  var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
  return t || (el.value || el.alt || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
}
function isBox(el) {
  return el && el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
}
function checked(el) {
  return !!el && (el.checked === true || el.getAttribute("aria-checked") === "true");
}
var hits = [];
Array.prototype.slice.call(document.querySelectorAll(CLICKABLE)).forEach(function (el) {
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return;
  var box = null, press = el, t;
  if (isBox(el)) {
    box = el;
    var lab = el.labels && el.labels[0];
    t = lab ? text(lab) : text(el);
    // 숨은 체크박스는 보이는 라벨을 누른다.
    if (!visible(el)) {
      if (!lab || !visible(lab)) return;
      press = lab;
    }
  } else {
    if (!visible(el)) return;
    t = text(el);
    if (el.tagName === "LABEL") {
      box = el.htmlFor ? document.getElementById(el.htmlFor) : null;
      if (!isBox(box)) box = el.querySelector('input[type="checkbox"], input[type="radio"]');
    } else if (el.getAttribute("role") === "checkbox") {
      box = el;
    }
  }
  if (t.indexOf(want) === -1) return;
  if (exact ? t !== want : (t.length > want.length + 10 && !box)) return;
  hits.push({ press: press, box: box, text: t, exact: t === want });
});
if (!hits.length) return null;
hits.sort(function (a, b) {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  return a.text.length - b.text.length;
});
var best = hits[0];
if (best.box && checked(best.box)) return { already: true, box: true, text: best.text.slice(0, 40) };
best.press.setAttribute("data-nts-fin", "1");
return { already: false, box: !!best.box, text: best.text.slice(0, 40) };
})`;

// 받아적기. 눌릴 만한 것(button·a·input·label)을 한 줄씩 적는다.
const DUMP_SRC = `(function () {
${HELPERS_JS}
var out = [];
Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], input, select, label'))
  .forEach(function (el) {
    if (!visible(el)) return;
    var kind = el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "");
    var cls = (el.className && el.className.baseVal === undefined) ? String(el.className).trim() : "";
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim() ||
      (el.value || el.alt || el.getAttribute("title") || el.getAttribute("aria-label") || "").trim();
    out.push(kind + (el.id ? "#" + el.id : "") + (cls ? "." + cls.split(/\\s+/).join(".") : "") +
             ' "' + text.slice(0, 60) + '"');
  });
return out;
})()`;

// 상품 페이지가 섰다는 긍정 신호. 캡차 페이지에는 이 값이 없다.
const PRODUCT_READY_SRC = "!!window.__PRELOADED_STATE__";

// ---------------------------------------------------------------------------

/**
 * 사는 데 쓰는 창 하나. 뜬 창·새로 열린 창·alert 를 한데 쥐고 있는다.
 *
 * alert 는 **받자마자 닫고 글자만 모아 둔다.** Playwright 는 듣는 쪽이 있으면 닫는 일을
 * 우리에게 맡기는데, 안 닫으면 그 페이지의 모든 조작이 멈춘다.
 */
export class Buyer {
  /** 지금 보고 있는 페이지. 주문서가 새 창으로 열리면 그쪽으로 옮긴다. */
  page: Page;
  readonly first: Page;
  private readonly dialogs: string[] = [];
  private gone = false;
  readonly closed: Promise<void>;

  /** 비밀번호 뒤 마지막 확인 화면에서 아직 못 누른 것. 결제가 끝나기를 지켜보는 동안 계속 두드린다. */
  finishLeft: string[] = [];

  constructor(readonly browser: Browser, readonly ctx: BrowserContext, page: Page) {
    this.page = this.first = page;
    ctx.on("dialog", (d) => {
      this.dialogs.push((d.message() || "").trim() || "(내용 없는 알림)");
      d.accept().catch(() => undefined);
    });
    this.closed = new Promise((resolve) => {
      const done = (): void => {
        this.gone = true;
        resolve();
      };
      browser.on("disconnected", done);
      ctx.on("close", done);
      // 사람이 창(탭)을 다 닫으면 끝난 것으로 본다. 브라우저 프로세스는 우리가 닫는다.
      const check = (): void => {
        if (!this.gone && ctx.pages().length === 0) {
          done();
          browser.close().catch(() => undefined);
        }
      };
      ctx.on("page", (p) => p.on("close", check));
      page.on("close", check);
    });
  }

  get isGone(): boolean {
    return this.gone;
  }

  /** 떠 있던 alert 의 글자. 없으면 null. */
  alertText(): string | null {
    return this.dialogs.shift() ?? null;
  }

  pages(): Page[] {
    return this.gone ? [] : this.ctx.pages().filter((p) => !p.isClosed());
  }

  async quit(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }
}

/**
 * 로그인 세션을 실은 새 창을 띄운다. 감시와 같은 세션 파일(naver_session.json)이다.
 * 크롬을 못 띄우면 BuyBrowserError 다.
 */
export async function openBuyer(sessionPath: string): Promise<Buyer> {
  let browser: Browser;
  try {
    browser = await launchBrowser(false);
  } catch (e) {
    throw new BuyBrowserError((e as Error).message);
  }
  try {
    // viewport 를 비워 둔다 — 사람이 보는 창이라 창 크기를 그대로 쓴다.
    const ctx = await browser.newContext({ storageState: sessionPath, locale: "ko-KR", userAgent: UA, viewport: null });
    const page = await ctx.newPage();
    return new Buyer(browser, ctx, page);
  } catch (e) {
    await browser.close().catch(() => undefined);
    throw new BuyBrowserError(`창을 준비하지 못했습니다: ${(e as Error).message}`);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

async function bodyText(target: Page | Frame): Promise<string> {
  try {
    return (await target.evaluate<string>("document.body ? document.body.innerText || '' : ''")) || "";
  } catch {
    return "";
  }
}

async function productReady(page: Page): Promise<boolean> {
  try {
    return !!(await page.evaluate<boolean>(PRODUCT_READY_SRC));
  } catch {
    return false;
  }
}

/**
 * 지금 서 있는 곳이 멀쩡한 상품 페이지인가. → 사유 (멀쩡하면 null)
 *
 * 자국(head 의 캡차 스크립트)이 있어도 **상품이 서 있으면 캡차가 아니다** — 캡차가 그
 * 자리에서 풀리면 자국만 남는다.
 */
async function landed(buyer: Buyer, timeout: number): Promise<string | null> {
  const page = buyer.page;
  await page.waitForLoadState("domcontentloaded", { timeout: timeout * 1000 }).catch(() => undefined);
  const alert = buyer.alertText();
  if (alert) return `상품 페이지에서 사이트가 알렸습니다 — ${alert}`;
  if (hostOf(page.url()).includes(LOGIN_HOST)) return SESSION_DEAD;

  // 상태 값은 문서가 선 뒤에 서는 일이 있다. 잠깐 기다린다.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(await productReady(page))) await sleep(250);
  if (await productReady(page)) return null;

  const head = await page.evaluate<string>("(document.head && document.head.outerHTML || '').slice(0, 2000)").catch(() => "");
  if (CAPTCHA_MARKS.some((m) => head.includes(m))) return CAPTCHA_SAID;
  const title = await page.title().catch(() => "");
  if (ERROR_PAGE_MARKS.some((m) => title.includes(m))) return ERROR_PAGE_SAID;
  return null; // 상태 값이 없어도 버튼이 있을 수 있다. 누르는 쪽이 판단한다.
}

/** 누른 뒤 화면이 달라졌는가. */
async function reacted(frame: Frame, before: string, waitFor = 1.5): Promise<boolean> {
  const deadline = Date.now() + waitFor * 1000;
  while (Date.now() < deadline) {
    try {
      if ((await frame.evaluate<string>(SIG_SRC)) !== before) return true;
    } catch {
      return true; // 페이지가 넘어갔다 — 그것도 달라진 것이다
    }
    await sleep(200);
  }
  return false;
}

/**
 * 화면에 그 글자가 보이는 것을 눌러 본다.
 *
 *   "ok"    눌렀고 화면이 달라졌다
 *   "quiet" 눌렀는데 화면이 그대로다
 *   "none"  못 찾았다
 */
async function clickText(buyer: Buyer, want: string, timeout = 8, tries = 3): Promise<Pressed> {
  const deadline = Date.now() + timeout * 1000;
  let attempts = 0;
  while (Date.now() < deadline && attempts < tries) {
    const frame = buyer.page.mainFrame();
    let got: { status: string; sig: string; what: string } | null = null;
    try {
      got = await frame.evaluate(`${FIND_TEXT_SRC}(${JSON.stringify(want)})`);
    } catch (e) {
      log.debug(`'${want}' 를 찾는 중 오류: ${(e as Error).message.split("\n")[0]}`);
    }
    if (got) {
      if (got.status === "already") return "ok";
      attempts += 1;
      if (await pressMarked(frame, "[data-nts-hit]")) {
        if (await reacted(frame, got.sig)) {
          log.debug(`'${want}' 를 눌렀습니다 — ${got.what}`);
          return "ok";
        }
        log.debug(`'${want}' 를 눌렀지만 화면이 그대로입니다 (${attempts}/${tries}) — ${got.what}`);
      }
    }
    await sleep(400);
  }
  return attempts ? "quiet" : "none";
}

async function clickAny(buyer: Buyer, wants: string[], timeout = 8): Promise<[Pressed, string | null]> {
  for (const want of wants) {
    const result = await clickText(buyer, want, timeout / wants.length, 2);
    if (result !== "none") return [result, want];
  }
  return ["none", null];
}

async function pickOption(buyer: Buyer, option: string, timeout: number): Promise<string | null> {
  await clickAny(buyer, OPTION_OPENERS, 3);
  await sleep(500);
  if ((await clickText(buyer, option, timeout, 2)) === "none") return `옵션 '${option}' 을 화면에서 못 찾았습니다`;
  const alert = buyer.alertText();
  return alert ? `옵션을 고르다 사이트가 알렸습니다 — ${alert}` : null;
}

/**
 * 수량을 올린다. 실패해도 멈추지 않는다 — 1개로 가는 것은 **덜 사는** 쪽이라 되돌리기 쉽다.
 */
async function setQuantity(buyer: Buyer, ea: number): Promise<string | null> {
  for (let i = 0; i < ea - 1; i++) {
    const [result] = await clickAny(buyer, ["증가", "+", "수량증가"], 3);
    if (result === "none") return `수량을 ${ea}개로 못 올렸습니다 (1개로 갑니다)`;
    await sleep(200);
  }
  return null;
}

function orderPage(buyer: Buyer): Page | null {
  return buyer.pages().find((p) => ORDER_HOSTS.some((h) => hostOf(p.url()).includes(h))) ?? null;
}

/**
 * 구매 레이어에서 바로구매까지 누른다. → 사유 (지나갔으면 null)
 *
 * **레이어가 안 떴으면 아무것도 하지 않는다.** 구매하기가 곧장 주문서로 가는 화면도 있다.
 */
async function throughLayer(buyer: Buyer, ea: number, timeout: number): Promise<string | null> {
  const deadline = Date.now() + Math.min(6, timeout) * 1000;
  let sawLayer = false;
  while (Date.now() < deadline) {
    if (orderPage(buyer)) return null;
    const body = await bodyText(buyer.page);
    if (LAYER_MARKS.some((m) => body.includes(m))) {
      sawLayer = true;
      break;
    }
    await sleep(300);
  }
  if (!sawLayer) return null;

  if (ea > 1) {
    const reason = await setQuantity(buyer, ea);
    if (reason) log.warn(reason);
  }
  const [result, pressed] = await clickAny(buyer, LAYER_CONFIRM, timeout);
  if (result === "none") return `구매 레이어에서 눌러야 할 것을 못 찾았습니다 (${LAYER_CONFIRM.join(" / ")})`;
  log.debug(`구매 레이어에서 '${pressed}' 를 눌렀습니다.`);
  return null;
}

/** 주문서에 도착했는가. 새 창으로 열릴 수도 있어 떠 있는 페이지를 다 본다. → [도착, 사유] */
async function arrived(buyer: Buyer, timeout: number): Promise<[boolean, string | null]> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    const alert = buyer.alertText();
    // 옵션 미선택·재고 부족·구매 불가는 전부 alert 로 온다.
    if (alert) return [false, `사이트가 알렸습니다 — ${alert}`];
    if (buyer.isGone) return [false, "창이 닫혔습니다"];

    if (buyer.pages().some((p) => hostOf(p.url()).includes(LOGIN_HOST))) return [false, SESSION_DEAD];
    const order = orderPage(buyer);
    if (order) {
      buyer.page = order;
      await order.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      const body = await bodyText(order);
      if (ORDER_MARKS.some((m) => body.includes(m))) return [true, null];
    }
    await sleep(400);
  }
  return [false, `구매하기를 눌렀지만 주문서로 넘어가지 않았습니다 (현재: ${buyer.page.url()})`];
}

/**
 * 상품 페이지를 열고 구매하기부터 주문서까지 누른다. → [주문서까지 갔는가, 사유]
 *
 * 창은 어떻게 끝나든 남긴다. 어디서 멈췄는지 사람이 봐야 판단이 된다.
 */
export async function buyOnPage(
  buyer: Buyer, url: string, opts: { option?: string; ea?: number; timeout?: number } = {},
): Promise<[boolean, string | null]> {
  const timeout = opts.timeout ?? 20;
  try {
    await buyer.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout * 1000 });
  } catch (e) {
    return [false, `상품 페이지를 여는 중 오류: ${(e as Error).message.split("\n")[0]}`];
  }
  const bad = await landed(buyer, timeout);
  if (bad) return [false, bad];

  if (opts.option) {
    const reason = await pickOption(buyer, opts.option, timeout);
    if (reason) return [false, reason];
  }
  const [result, pressed] = await clickAny(buyer, BUY_TEXTS, timeout);
  if (result === "none") return [false, `구매 버튼을 못 찾았습니다 (${BUY_TEXTS.join(" / ")})`];
  log.debug(`'${pressed}' 를 눌렀습니다.`);

  const reason = await throughLayer(buyer, opts.ea ?? 1, timeout);
  if (reason) return [false, reason];
  return arrived(buyer, timeout);
}

// 결제하기를 누른 **다음** 화면. 네이버페이는 결제 버튼 다음에 간편결제 인증을 세운다.
const AUTH_MARKS = ["비밀번호", "인증", "지문", "얼굴", "생체", "패턴"];
// 인증 없이 곧장 끝난 경우. 그런 계정에서는 submit 을 켜면 안 된다는 신호라 크게 알린다.
const DONE_MARKS = ["결제가 완료", "주문이 완료", "결제완료", "구매가 완료"];
export const PAID_ANYWAY = "결제가 끝났습니다 — 인증 없이 넘어갔습니다";
export const PG_OPENED = "결제 인증 화면이 떴습니다";
export const PG_BLOCKED = "결제창이 뜨기 전에 사이트가 막았습니다";
export const PG_UNSEEN = "결제하기는 눌렀지만 결제 인증 화면 신호를 못 봤습니다 — 창을 봐주세요";

const marksIn = (body: string, marks: string[]): Set<string> => new Set(marks.filter((m) => body.includes(m)));

/**
 * 주문서에서 결제하기를 눌러 **인증 앞까지** 간다. → [눌렀나, 무슨 일이 있었나]
 *
 * 인증 화면은 주문서 본문이 아니라 새 창이나 iframe 에 뜬다. 그래서 **새 창·새 iframe·
 * alert·본문 글자를 다 본다.** 본문 글자는 누르기 전에 이미 있던 것은 세지 않는다.
 *
 * **주문서가 아니면 아무것도 하지 않는다.** 엉뚱한 화면에서 "결제하기" 를 누르는 것이
 * 제일 나쁜 경우다.
 */
export async function payHere(buyer: Buyer, timeout = 20): Promise<[boolean, string]> {
  const order = orderPage(buyer);
  if (!order) return [false, "주문서가 아닙니다 — 누르지 않았습니다"];
  buyer.page = order;

  let found: { label: string; named: boolean; count: number } | null = null;
  try {
    found = await order.evaluate(`${PAY_FIND_SRC}(${JSON.stringify(PAY_TEXT)}, ${JSON.stringify(PAY_CLASS)})`);
  } catch (e) {
    log.debug(`결제 버튼을 찾는 중 오류: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!found) return [false, `결제 버튼을 못 찾았습니다 ('${PAY_TEXT}')`];
  log.debug(`결제 버튼 — ${JSON.stringify(found.label)} (클래스로 ${found.named} · 후보 ${found.count}개)`);

  const before = new Set(buyer.pages());
  const frames = order.mainFrame().childFrames().length;
  const firstBody = await bodyText(order);
  const hadAuth = marksIn(firstBody, AUTH_MARKS);
  const hadDone = marksIn(firstBody, DONE_MARKS);

  if (!(await pressMarked(order.mainFrame(), "[data-nts-pay]"))) return [false, "결제 버튼을 누르지 못했습니다"];
  log.debug("결제 버튼을 눌렀습니다 — 인증 화면 신호를 기다립니다.");

  const deadline = Date.now() + Math.min(timeout, 15) * 1000;
  while (Date.now() < deadline) {
    const alert = buyer.alertText();
    if (alert) return [true, `${PG_BLOCKED} — ${alert}`];
    if (buyer.isGone) return [true, "눌렀지만 창이 사라졌습니다"];

    if (buyer.pages().some((p) => !before.has(p))) {
      log.debug("결제 인증 화면이 새 창으로 떴습니다.");
      return [true, PG_OPENED];
    }
    if (!order.isClosed() && order.mainFrame().childFrames().length > frames) {
      log.debug("결제 인증 화면이 이 창에 iframe 으로 얹혔습니다.");
      return [true, PG_OPENED];
    }
    const body = await bodyText(order);
    if (DONE_MARKS.some((m) => !hadDone.has(m) && body.includes(m))) return [true, PAID_ANYWAY];
    const auth = AUTH_MARKS.find((m) => !hadAuth.has(m) && body.includes(m));
    if (auth) {
      log.debug(`결제 인증 화면이 이 페이지에 떴습니다 ('${auth}').`);
      return [true, PG_OPENED];
    }
    await sleep(300);
  }
  return [true, PG_UNSEEN];
}

// ---------------------------------------------------------------------------
// 비밀번호 뒤 마지막 확인 — extension 의 "네이버페이 마지막 확인 (비밀번호 뒤)" 흐름.
// ---------------------------------------------------------------------------

// 이 화면이 뜨는 곳. 주문서(orders.pay.naver.com)는 빼려고 앞에 :// 를 붙였다 (extension 과 같다).
const FINISH_MATCH = "://pay.naver.com";
// 마지막 단계는 글자가 딱 맞는 것만 누른다. 누르는 순간 결제가 확정되는 버튼이다.
const FINISH_EXACT = new Set(["결제"]);

/** 마지막 확인 화면이 뜰 수 있는 프레임들. */
function finishFrames(buyer: Buyer): Frame[] {
  return buyer.pages().flatMap((p) => p.frames()).filter((f) => f.url().includes(FINISH_MATCH));
}

async function findFinish(buyer: Buyer, want: string): Promise<[{ already: boolean; box: boolean; text: string }, Frame] | null> {
  for (const frame of finishFrames(buyer)) {
    try {
      const got = await frame.evaluate<{ already: boolean; box: boolean; text: string } | null>(
        `${FINISH_FIND_SRC}(${JSON.stringify(want)}, ${FINISH_EXACT.has(want)})`);
      if (got) return [got, frame];
    } catch {
      // 프레임이 갈렸다. 다음 것을 본다.
    }
  }
  return null;
}

/**
 * 비밀번호를 넣고 나서 한 번 더 오는 **마지막 확인 화면**에서 남은 것을 누른다. → 아직 남은 것
 *
 * 네이버페이는 비밀번호 뒤에 "결제내용에 동의하시면 '결제' 버튼을 눌러 구매완료합니다." 체크와
 * `결제` 버튼을 한 번 더 세운다 (bnkr-test NPAY_FINISH, 2026-08-25 에 본 화면).
 *
 * **순서대로만 나아간다.** 앞엣것을 못 찾았으면 그 화면이 아직 아니라는 뜻이라 뒤엣것은
 * 건드리지 않는다 — 동의 체크가 안 된 채 결제를 누르는 꼴을 막는다. 체크는 눌러 본 뒤
 * 정말 켜졌는지까지 보고 넘어간다.
 */
export async function tryFinish(buyer: Buyer, pending: string[]): Promise<string[]> {
  const left = [...pending];
  while (left.length && !buyer.isGone) {
    const want = left[0]!;
    const found = await findFinish(buyer, want);
    if (!found) break;
    const [hit, frame] = found;
    if (hit.already) {
      left.shift();
      log.debug(`확인 화면의 '${want}' 는 이미 체크돼 있습니다`);
      continue;
    }
    if (!(await pressMarked(frame, "[data-nts-fin]"))) break;
    if (hit.box) {
      // 체크가 정말 켜졌는지 본다. 안 켜졌으면 다음 바퀴에 다시 누른다.
      await sleep(150);
      const again = await findFinish(buyer, want);
      if (again && !again[0].already) break;
    }
    left.shift();
    log.info(`✅ 확인 화면에서 '${want}' 를 눌렀습니다 ← "${hit.text}"`);
    // 동의 체크 → 결제 버튼이 살아나는 사이 (extension settleMs 100)
    if (left.length) await sleep(100);
  }
  return left;
}

// ---------------------------------------------------------------------------
// 받아적기 — 처음 한 판이 셀렉터를 고칠 유일한 재료다. 사람 정보는 가린다.
// ---------------------------------------------------------------------------

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /\b01[016-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const INPUT_TAG_RE = /<input\b[^>]*>/gi;
const TYPE_RE = /\btype\s*=\s*["']?([\w-]+)/i;
const VALUE_RE = /(\bvalue\s*=\s*)(["'])([\s\S]*?)\2/gi;
const TYPED_INPUTS = new Set(["", "text", "email", "tel", "password", "number", "search", "url", "hidden"]);

function scrub(text: string): string {
  return text
    .replace(INPUT_TAG_RE, (tag) => {
      const kind = TYPE_RE.exec(tag)?.[1]?.toLowerCase() ?? "";
      if (!TYPED_INPUTS.has(kind)) return tag;
      return tag.replace(VALUE_RE, (_m, head: string, quote: string) => `${head}${quote}(가림)${quote}`);
    })
    .replace(EMAIL_RE, "(이메일)")
    .replace(PHONE_RE, "(휴대폰)")
    .replace(CARD_RE, "(긴숫자)");
}

// 마크업을 남기지 않을 자리. 주문서에는 배송지·받는 사람이 글자로 박혀 있다.
const NO_HTML_MARK = "/ordersheet";

/**
 * 떠 있는 창을 **전부**, 창마다 프레임을 전부 돌며 눌릴 만한 것을 적는다. → 적었으면 true
 * 주문서가 아닌 곳은 마크업까지 남긴다. 자판을 읽을 수 있었는지도 적는다(pin.ts 가 보는 그대로).
 */
export async function dumpPayment(buyer: Buyer, path: string): Promise<boolean> {
  const lines: string[] = [`# 네이버 결제하기 뒤 받아적기 (naver/ts) — ${new Date().toISOString()}`];
  const html: string[] = [];
  const pages = buyer.pages();
  if (!pages.length) {
    log.warn("창이 없어 받아 적지 못했습니다.");
    return false;
  }
  for (const [n, page] of pages.entries()) {
    const tag = page === buyer.first ? `창 ${n} (처음 연 창)` : `창 ${n}`;
    for (const [m, frame] of page.frames().entries()) {
      const where = frame.url();
      let found: string[];
      try {
        found = await frame.evaluate<string[]>(DUMP_SRC);
      } catch (e) {
        lines.push(`\n[${tag} · frame ${m}] 읽지 못함: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      lines.push(`\n[${tag} · frame ${m}] ${where}  (${found.length}개)`);
      lines.push(...found.map((item) => `  ${item}`));
      try {
        const pad = await frame.evaluate<[string, unknown[], boolean, string] | null>(KEYPAD_SRC);
        lines.push(pad
          ? `  [자판 읽기] ${pad[0]} — 키 ${pad[1]?.length ?? 0}개 · 확인 키 ${pad[2] ? "있음" : "없음"}`
          : "  [자판 읽기] 없음 — 자판으로 안 보입니다");
      } catch (e) {
        lines.push(`  [자판 읽기] 실패: ${(e as Error).message.split("\n")[0]}`);
      }
      if (!where.includes(NO_HTML_MARK)) {
        const body = await frame.evaluate<string>("document.body ? document.body.outerHTML : ''").catch(() => "");
        if (body) html.push(`\n\n===== [${tag} · frame ${m}] ${where} =====\n${body.slice(0, 200_000)}`);
      }
    }
  }
  lines.push(...html);
  try {
    writeFileSync(path, scrub(lines.join("\n")), "utf8");
    return true;
  } catch (e) {
    log.warn(`결제창 내용을 적지 못했습니다: ${(e as Error).message}`);
    return false;
  }
}
