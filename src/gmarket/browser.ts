/**
 * G마켓 상품 페이지를 **감시하는 창에 새 탭으로** 열어 구매하기부터 결제하기까지 누른다.
 *
 *   새 탭(감시 탭과 같은 쿠키) → 상품 페이지 → [옵션] → [수량] → 구매하기
 *   → 주문서 도착 확인 → [필수 동의] → [결제수단] → 결제하기 → 스마일페이 비밀번호 자판
 *
 * 감시 탭과 같은 크롬이라 쿠키가 같고, Cloudflare 봇 확인을 사람이 한 번 마치면 감시와 구매가
 * 같이 이어간다. 사는 탭은 **늘 창에** 연다 — 감시가 창 없이 돌고 있었으면 그 순간 창으로 다시
 * 띄운다 (1~2초, session.ts 의 show). 봇 확인이 뜨면 **아무것도 누르지 않고** 사람이 그 탭에서
 * 마치기를 기다린다 (bot_check_wait_seconds).
 *
 * 스마트스토어 판(../browser.ts)과 같은 짜임이다. 누를 것을 고르는 일은 페이지 안의
 * 자바스크립트가 하고(표시 `data-gm-*` 를 단다), 누르는 일은 퍼피티어가 한다 (press.ts) —
 * 자바스크립트로 부른 click 은 isTrusted 가 false 라 창을 여는 버튼이면 크롬이 막는다.
 *
 * **상품 페이지는 본 것이다** (2026-09-26, 게스트로 열어 봤다).
 *
 *   button#coreInsOrderBtn.btn_primary.btn_blue  "구매하기"      ← 이것만 누른다
 *   button#coreAddCartBtn                        "장바구니"      ← 누르면 안 된다
 *   button.bt_increase "수량증가" · input.num "1" · button.bt_decrease "수량감소"
 *   품절이면 구매하기가 아예 없고 <strong class="price_real text__soldout">SOLD OUT</strong>
 *
 * 구매하기는 /Item/AddCartV2 로 담은 뒤 사이트가 돌려준 OrderUrl 로 넘어간다
 * (script.gmarket.co.kr/js/itemdweb/pages/Order.js 의 buyItNow). 막히면 alert 로 말한다.
 * 로그인이 안 돼 있으면 signinssl.gmarket.co.kr/Login/Login?url=…&Entrance=PAY 로 간다.
 *
 * **주문서 · 결제창 · 자판은 못 봤다.** 로그인해야 가는 자리다. 그래서 글자로 찾고,
 * 처음 한 판은 `--dump-pay` 로 받아 적어 고치라고 README 에 적어 뒀다.
 */
import { writeFileSync } from "node:fs";
import type { Browser, Frame, Page } from "puppeteer";
import { log, sleep } from "../log.js";
import { looksLikeBotCheck } from "./parse.js";
import { KEYPAD_SRC } from "./pin.js";
import { HELPERS_JS, js, pressMarked, type Pressed } from "./press.js";
import type { Watcher } from "./session.js";

export type { Pressed };

const LOGIN_HOSTS = ["signinssl.gmarket.co.kr", "signin.gmarket.co.kr", "sslmember2.gmarket.co.kr"];
export const SESSION_DEAD = "G마켓 로그인이 풀렸습니다";
export const BOT_CHECK_SAID = "Cloudflare 봇 확인을 사람이 마치지 않았습니다";
const ITEM_HOST = "item.gmarket.co.kr";

const BUY_SELECTOR = "#coreInsOrderBtn";

// 주문서. **못 본 화면이다.** 주소와 글자와 결제 버튼 셋으로 본다.
const ORDER_HOSTS = ["checkout.gmarket.co.kr", "escrow.gmarket.co.kr", "order.gmarket.co.kr", "pay.gmarket.co.kr"];
const ORDER_MARKS = ["주문/결제", "주문서", "배송지", "결제수단", "결제 수단", "최종 결제", "주문상품", "받는 분", "받는분"];
// 주문서가 아닌 G마켓 자리. 여기서는 결제하기가 보여도 주문서로 치지 않는다.
const NOT_ORDER_HOSTS = [ITEM_HOST, ...LOGIN_HOSTS, "www.gmarket.co.kr", "minishop.gmarket.co.kr"];

const OPTION_OPENERS = ["선택하세요", "옵션 선택", "옵션선택", "선택"];

/** 창을 띄우지 못했다. 사는 일만 못 하는 것이지 감시를 접을 일은 아니다. */
export class BuyBrowserError extends Error {
  override name = "BuyBrowserError";
}

// ---------------------------------------------------------------------------
// 페이지 안에서 돌리는 조각들. 함수가 아니라 **문자열**로 넘긴다 (tsx 의 __name 문제).
// ---------------------------------------------------------------------------

const SIG_SRC = `(function () { ${HELPERS_JS} return sig(); })()`;

// 글자로 눌러야 할 것을 찾아 data-gm-hit 표시를 단다. 스마트스토어 판의 FIND_TEXT 그대로다.
// → null(못 찾음) | {status: "already"|"found", sig, what}
const FIND_TEXT_SRC = `(function (want) {
${HELPERS_JS}
Array.prototype.slice.call(document.querySelectorAll("[data-gm-hit]")).forEach(function (el) {
  el.removeAttribute("data-gm-hit");
});
function handles(el) {
  var tag = el.tagName;
  if (tag === "A" || tag === "BUTTON" || tag === "LABEL" || tag === "INPUT") return true;
  if (el.onclick || el.getAttribute("onclick") || el.getAttribute("href")) return true;
  if (el.getAttribute("role") === "button" || el.getAttribute("role") === "radio" || el.getAttribute("role") === "tab") return true;
  return false;
}
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
// 숨은 라디오·체크박스는 보이는 라벨을 누른다.
if ((target.type === "checkbox" || target.type === "radio") && !visible(target)) {
  var lab = target.labels && target.labels[0];
  if (lab && visible(lab)) target = lab;
}
target.setAttribute("data-gm-hit", "1");
return { status: "found", sig: sig(), what: describe(target) };
})`;

// 상품 페이지가 섰는가 · 로그인했는가 · 품절인가.
const ITEM_READY_SRC = `(function () {
var b = document.querySelector(${JSON.stringify(BUY_SELECTOR)});
var h = window.GmarketHeaderComm;
return {
  buy: !!b && !b.disabled,
  sold: !!document.querySelector(".text__soldout"),
  login: h && h.Member ? String(h.Member.IsLogin) : null
};
})()`;

// 구매하기 곁의 수량 칸. 상품 페이지에는 수량 칸이 둘(위·옆 날개) 있어서, 구매하기에서
// 위로 올라가며 **같은 상자 안의 것**을 쓴다. → 지금 수량 | null(못 찾음)
const QTY_FIND_SRC = `(function () {
Array.prototype.slice.call(document.querySelectorAll("[data-gm-inc], [data-gm-num]")).forEach(function (el) {
  el.removeAttribute("data-gm-inc");
  el.removeAttribute("data-gm-num");
});
var buy = document.querySelector(${JSON.stringify(BUY_SELECTOR)});
if (!buy) return null;
for (var box = buy.parentElement; box && box !== document.body; box = box.parentElement) {
  var inc = box.querySelector(".bt_increase"), num = box.querySelector("input.num");
  if (inc && num) {
    inc.setAttribute("data-gm-inc", "1");
    num.setAttribute("data-gm-num", "1");
    return Number(num.value) || 0;
  }
}
return null;
})()`;
const QTY_NOW_SRC = `(function () { var n = document.querySelector("[data-gm-num]"); return n ? Number(n.value) || 0 : null; })()`;

// 주문서로 보이는가. → {marks: 걸린 글자 수, pay: 결제 버튼이 있나}
const ORDER_PROBE_SRC = `(function (marks) {
var body = document.body ? document.body.innerText || "" : "";
var n = 0;
marks.forEach(function (m) { if (body.indexOf(m) !== -1) n++; });
var pay = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
  .some(function (el) { return ((el.textContent || "") + " " + (el.value || "")).indexOf("결제하기") !== -1; });
return { marks: n, pay: pay };
})`;

// 주문서 맨 아래의 결제 버튼. 금액이 함께 박혀 있을 수 있어("12,000원 결제하기") **품고
// 있는지**로 찾는다 — 글자가 딱 맞는 것만 찾다가 네이버페이 판에서 세 번 못 찾았다.
const PAY_TEXT = "결제하기";
const PAY_FIND_SRC = `(function (want) {
${HELPERS_JS}
Array.prototype.slice.call(document.querySelectorAll("[data-gm-pay]")).forEach(function (el) {
  el.removeAttribute("data-gm-pay");
});
var hits = [];
Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
  .forEach(function (el) {
    if (!visible(el) || el.disabled === true || el.getAttribute("aria-disabled") === "true") return;
    var text = ((el.textContent || "") + " " + (el.value || "")).replace(/\\s+/g, " ").trim();
    if (text.indexOf(want) === -1) return;
    hits.push({ el: el, text: text });
  });
if (!hits.length) return null;
hits.sort(function (a, b) { return a.text.length - b.text.length; });
hits[0].el.setAttribute("data-gm-pay", "1");
return { label: hits[0].text.slice(-30), count: hits.length };
})`;

/**
 * 필수 동의만 체크한다. **보이는 체크박스를 다 누르면 안 된다** — 광고 수신 동의, "이
 * 결제수단을 다음에도 사용" 같은 것까지 켜진다 (롯데온 주문서에 실제로 있었다).
 *
 * 아직 안 켜져 있고, 옆 글에 "필수" 나 "(결제|구매|주문) … 동의" 가 있고, 선택·광고·
 * 마케팅·수신·혜택·이벤트가 없는 것만 누른다. 하나도 안 걸리면 아무것도 안 한 것이다 —
 * 실패가 아니다. 눌러야 하는 것이었다면 사이트가 결제하기에서 alert 로 막는다.
 */
const AGREE_SRC = `(function () {
function seen(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}
function about(box) {
  var text = "";
  if (box.id) {
    var tag = document.querySelector('label[for="' + box.id + '"]');
    if (tag) text = tag.textContent || "";
  }
  if (!text) {
    var wrap = box.closest("label, li, tr, dd, p, div");
    if (wrap) text = wrap.textContent || "";
  }
  return text.replace(/\\s+/g, " ").trim().slice(0, 100);
}
var ticked = [], left = [];
Array.prototype.slice.call(document.querySelectorAll('input[type="checkbox"]')).forEach(function (box) {
  var tag = box.id ? document.querySelector('label[for="' + box.id + '"]') : null;
  if (!seen(box) && !(tag && seen(tag))) return;
  var text = about(box);
  if (text.indexOf("필수") === -1 && !/(결제|구매|주문)[^.]{0,30}동의/.test(text)) return;
  if (/선택|광고|마케팅|수신|혜택|이벤트/.test(text)) return;
  if (box.checked) return;
  if (tag) tag.click();
  if (!box.checked) box.click();
  if (!box.checked) {
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }
  (box.checked ? ticked : left).push(text);
});
return [ticked, left];
})()`;

// 받아적기. 눌릴 만한 것(button·a·input·label)을 한 줄씩 적는다.
// **글 넣는 칸은 값을 적지 않는다** (자리 표시와 글자 수만) — 주문서의 받는 분·주소·연락처 칸에는
// 사람 정보가 값으로 들어 있다. 예전 판은 값을 그대로 적었다 (가짜 페이지 시험에서 드러났다).
const DUMP_SRC = `(function () {
${HELPERS_JS}
var out = [];
Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], [role="radio"], [role="tab"], input, select, label'))
  .forEach(function (el) {
    if (!visible(el)) return;
    var kind = el.tagName.toLowerCase() + (el.type ? "[" + el.type + "]" : "");
    var cls = (el.className && el.className.baseVal === undefined) ? String(el.className).trim() : "";
    var typed = el.tagName === "INPUT" && /^(text|email|tel|password|number|search|url|)$/i.test(el.getAttribute("type") || "");
    var text = (el.textContent || "").replace(/\\s+/g, " ").trim() ||
      (typed ? (el.getAttribute("placeholder") || "") + (el.value ? " (값 " + String(el.value).length + "자)" : "")
             : (el.value || el.alt || el.getAttribute("title") || el.getAttribute("aria-label") || "")).trim();
    var state = (el.checked ? " [켜짐]" : "") + (el.disabled ? " [비활성]" : "");
    out.push(kind + (el.id ? "#" + el.id : "") + (cls ? "." + cls.split(/\\s+/).join(".") : "") +
             ' "' + text.slice(0, 60) + '"' + state);
  });
return out;
})()`;

// ---------------------------------------------------------------------------

/**
 * 사는 데 쓰는 탭 하나와, 그 탭에서 새로 열린 창들(주문서·결제창). alert 도 한데 쥐고 있는다.
 *
 * 감시 탭과 같은 크롬(같은 쿠키)에 있지만 **제 탭만 본다** — 탭에서 열린 팝업을 따라가며
 * 모은다. 감시 탭을 주문서로 착각하거나 받아적기에 섞지 않는다.
 *
 * alert 는 **받자마자 닫고 글자만 모아 둔다** — 안 닫으면 그 페이지의 모든 조작이 멈춘다
 * (퍼피티어는 Playwright 와 달리 alert 를 저절로 닫아 주지 않는다).
 */
export class Buyer {
  /** 지금 보고 있는 페이지. 주문서가 새 창으로 열리면 그쪽으로 옮긴다. */
  page: Page;
  readonly first: Page;
  private readonly dialogs: string[] = [];
  private readonly own = new Set<Page>();
  private gone = false;
  private resolveClosed: () => void = () => undefined;
  readonly closed: Promise<void>;

  constructor(readonly browser: Browser, page: Page) {
    this.page = this.first = page;
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    browser.once("disconnected", () => this.finish());
    this.track(page);
  }

  private track(p: Page): void {
    this.own.add(p);
    p.on("dialog", (d) => {
      this.dialogs.push((d.message() || "").trim() || "(내용 없는 알림)");
      d.accept().catch(() => undefined);
    });
    p.on("popup", (q) => q && this.track(q));
    // 사람이 이 탭과 거기서 열린 창을 다 닫으면 끝난 것으로 본다.
    p.on("close", () => {
      if (![...this.own].some((one) => !one.isClosed())) this.finish();
    });
  }

  private finish(): void {
    if (this.gone) return;
    this.gone = true;
    this.resolveClosed();
  }

  get isGone(): boolean {
    return this.gone;
  }

  alertText(): string | null {
    return this.dialogs.shift() ?? null;
  }

  pages(): Page[] {
    return this.gone ? [] : [...this.own].filter((p) => !p.isClosed());
  }

  /** 제 탭과 창만 닫는다. 감시 탭은 그대로 둔다. */
  async quit(): Promise<void> {
    await Promise.all(this.pages().map((p) => p.close().catch(() => undefined)));
    this.finish();
  }
}

/**
 * 감시하는 크롬에 사는 탭을 연다. 크롬이 죽었으면 감시 쪽이 다시 띄운다.
 * 창 없이 돌고 있었으면 감시 쪽이 먼저 창을 띄운다 (session.ts 의 show).
 */
export async function openBuyer(watcher: Watcher): Promise<Buyer> {
  let page: Page;
  try {
    page = await watcher.newTab();
  } catch (e) {
    throw new BuyBrowserError(`사는 탭을 열지 못했습니다: ${(e as Error).message.split("\n")[0]}`);
  }
  return new Buyer(page.browser(), page);
}

// 봇 확인 화면이 스스로 세우는 것. 마크업 전체를 긁지 않고 이것만 본다 (주문서를 기다리며 1초마다 본다).
// challenge-platform 스크립트만으로 보면 안 된다 — 멀쩡한 페이지에도 .../scripts/jsd/main.js 가 붙는다.
const BOT_SRC = `!!window._cf_chl_opt || !!document.querySelector(
  'script[src*="orchestrate/chl_page"], iframe[src*="challenges.cloudflare.com"]')`;

/** 이 페이지가 지금 Cloudflare 봇 확인 화면인가. */
async function botCheckOn(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  if (await js<boolean>(page, BOT_SRC).catch(() => false)) return true;
  // 막 넘어가는 중이면 위가 못 볼 수 있다. 제목·글자로 한 번 더 본다 (parse.ts 와 같은 기준).
  const title = await page.title().catch(() => "");
  return /잠시만 기다리십시오|Just a moment/i.test(title) && looksLikeBotCheck(await page.content().catch(() => ""));
}

/**
 * 봇 확인이 떴다. **아무것도 누르지 않고** 사람이 그 탭에서 마치기를 기다린다. → 마쳤으면 true
 * 확인이 끝나면 Cloudflare 가 원래 가려던 페이지로 되돌려 보낸다.
 */
async function waitHuman(page: Page, seconds: number, onBotCheck?: () => unknown): Promise<boolean> {
  log.warn(`🤖 Cloudflare 봇 확인이 떴습니다 — 크롬 창에서 직접 확인을 마쳐 주세요 (최대 ${seconds}초 기다립니다)`);
  void onBotCheck?.();
  await page.bringToFront().catch(() => undefined);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (page.isClosed()) return false;
    if (!(await botCheckOn(page))) {
      log.info("확인됐습니다 — 이어갑니다");
      await page.waitForFunction("document.readyState !== 'loading'", { timeout: 10_000, polling: 200 }).catch(() => undefined);
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const atLogin = (url: string): boolean => LOGIN_HOSTS.includes(hostOf(url));

async function bodyText(target: Page | Frame): Promise<string> {
  try {
    return (await js<string>(target, "document.body ? document.body.innerText || '' : ''")) || "";
  } catch {
    return "";
  }
}

/** 누른 뒤 화면이 달라졌는가. */
async function reacted(frame: Frame, before: string, waitFor = 1.5): Promise<boolean> {
  const deadline = Date.now() + waitFor * 1000;
  while (Date.now() < deadline) {
    try {
      if ((await js<string>(frame, SIG_SRC)) !== before) return true;
    } catch {
      return true; // 페이지가 넘어갔다 — 그것도 달라진 것이다
    }
    await sleep(200);
  }
  return false;
}

/**
 * 화면에 그 글자가 보이는 것을 눌러 본다.
 *   "ok" 눌렀고 화면이 달라졌다 · "quiet" 눌렀는데 그대로다 · "none" 못 찾았다
 */
async function clickText(page: Page, want: string, timeout = 8, tries = 3): Promise<Pressed> {
  const deadline = Date.now() + timeout * 1000;
  let attempts = 0;
  while (Date.now() < deadline && attempts < tries) {
    const frame = page.mainFrame();
    let got: { status: string; sig: string; what: string } | null = null;
    try {
      got = await js(frame, `${FIND_TEXT_SRC}(${JSON.stringify(want)})`);
    } catch (e) {
      log.debug(`'${want}' 를 찾는 중 오류: ${(e as Error).message.split("\n")[0]}`);
    }
    if (got) {
      if (got.status === "already") return "ok";
      attempts += 1;
      if (await pressMarked(frame, "[data-gm-hit]")) {
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

/**
 * 상품 페이지가 섰는가. → 사유 (살 수 있게 섰으면 null)
 *
 * **로그인이 안 돼 있으면 구매하기를 누르지 않는다.** 누르면 로그인 화면으로 넘어가는데,
 * 그건 사는 게 아니라 창 하나를 로그인 화면에 세워 두는 일이다.
 */
async function landed(buyer: Buyer, timeout: number): Promise<string | null> {
  const page = buyer.page;
  type Ready = { buy: boolean; sold: boolean; login: string | null };
  const deadline = Date.now() + Math.min(timeout, 8) * 1000;
  let seen: Ready | null = null;
  while (Date.now() < deadline) {
    const alert = buyer.alertText();
    if (alert) return `상품 페이지에서 사이트가 알렸습니다 — ${alert}`;
    if (atLogin(page.url())) return SESSION_DEAD;
    seen = await js<Ready | null>(page, ITEM_READY_SRC).catch(() => null);
    if (seen && (seen.buy || seen.sold)) break;
    await sleep(200);
  }
  // 로그인 표시(GmarketHeaderComm)조차 없으면 상품 페이지가 아니다 — 차단 화면일 수 있다.
  // **품절로 읽으면 안 된다.** 품절로 읽으면 "한발 늦었다" 로 치고 넘어간다.
  if (!seen || seen.login === null) {
    const title = await page.title().catch(() => "");
    return `상품 페이지가 서지 않았습니다 (${title || "제목 없음"} · ${page.url()})`;
  }
  if (seen.login === "0") return SESSION_DEAD;
  if (seen.sold) return "상품 페이지에서 품절입니다 (SOLD OUT)";
  if (!seen.buy) return "상품 페이지에 구매하기가 없습니다";
  return null;
}

// 상품 페이지는 집 IP 에서도 가끔 403 을 준다 (gmarket_item_stock.py 가 겪은 것, 2026-09-26 에
// 여기서도 봤다 — 제목이 "G마켓 - 쇼핑을 바꾸는 쇼핑" 인 차단 화면이다). 한두 번은 다시 연다.
// 처음엔 쉬지 않고 네 번 열었는데, 그렇게 두드리는 것이 바로 봇 확인을 부르는 짓이라 줄였다.
const BLOCK_STATUSES = new Set([403, 429, 503]);
const REOPEN_TRIES = 2;

/** 봇 확인이 떴을 때 사람을 얼마나 기다릴지, 그리고 누구에게 알릴지. */
export interface BotWait {
  seconds: number;
  notify?: () => unknown;
}

async function openItem(buyer: Buyer, url: string, timeout: number, bot: BotWait): Promise<string | null> {
  let status = 0;
  for (let n = 0; n < REOPEN_TRIES; n++) {
    try {
      const resp = await buyer.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeout * 1000 });
      status = resp?.status() ?? 0;
    } catch (e) {
      return `상품 페이지를 여는 중 오류: ${(e as Error).message.split("\n")[0]}`;
    }
    // 봇 확인은 **다시 열지 않는다.** 사람이 마치면 Cloudflare 가 상품 페이지로 되돌려 보낸다.
    if (status !== 200 && (await botCheckOn(buyer.page))) {
      return (await waitHuman(buyer.page, bot.seconds, bot.notify)) ? null : BOT_CHECK_SAID;
    }
    if (!BLOCK_STATUSES.has(status)) return null;
    if (n < REOPEN_TRIES - 1) {
      log.warn(`상품 페이지가 HTTP ${status} 로 막혔습니다 — 1초 뒤 한 번 더 엽니다`);
      await sleep(1000);
    }
  }
  return `상품 페이지가 HTTP ${status} 로 막혔습니다 (${REOPEN_TRIES}번)`;
}

async function pickOption(buyer: Buyer, option: string, timeout: number): Promise<string | null> {
  for (const opener of OPTION_OPENERS) {
    if ((await clickText(buyer.page, opener, 2, 1)) !== "none") break;
  }
  await sleep(400);
  if ((await clickText(buyer.page, option, timeout, 2)) === "none") return `옵션 '${option}' 을 화면에서 못 찾았습니다`;
  const alert = buyer.alertText();
  return alert ? `옵션을 고르다 사이트가 알렸습니다 — ${alert}` : null;
}

/**
 * 수량을 올린다. 실패해도 멈추지 않는다 — 1개로 가는 것은 **덜 사는** 쪽이라 되돌리기 쉽다.
 * 한도를 넘겨 누르면 사이트가 alert 로 막는다. 그때도 거기서 멈추고 그 수량으로 간다.
 */
async function setQuantity(buyer: Buyer, ea: number): Promise<void> {
  const frame = buyer.page.mainFrame();
  // 수량 칸은 스크립트가 그린다. 구매하기보다 늦게 설 수 있어 잠깐 기다린다.
  let now: number | null = null;
  for (const until = Date.now() + 3000; now === null && Date.now() < until;) {
    now = await js<number | null>(frame, QTY_FIND_SRC).catch(() => null);
    if (now === null) await sleep(150);
  }
  if (now === null) {
    log.warn(`수량 칸을 못 찾았습니다 — ${ea}개 대신 사이트 기본 수량으로 갑니다`);
    return;
  }
  for (let guard = 0; now < ea && guard < ea + 3; guard++) {
    if (!(await pressMarked(frame, "[data-gm-inc]"))) break;
    await sleep(150);
    const alert = buyer.alertText();
    if (alert) {
      log.warn(`수량을 올리다 사이트가 막았습니다 — ${alert}`);
      break;
    }
    now = (await js<number | null>(frame, QTY_NOW_SRC).catch(() => null)) ?? now;
  }
  if (now !== ea) log.warn(`수량을 ${ea}개로 못 맞췄습니다 — ${now}개로 갑니다`);
  else log.debug(`수량 ${ea}개`);
}

/** 이 페이지가 주문서인가. 주소·글자·결제 버튼으로 본다. */
async function isOrder(page: Page): Promise<boolean> {
  const url = page.url();
  const host = hostOf(url);
  if (!host.endsWith("gmarket.co.kr") || NOT_ORDER_HOSTS.includes(host)) return false;
  const got = await js<{ marks: number; pay: boolean }>(
    page, `${ORDER_PROBE_SRC}(${JSON.stringify(ORDER_MARKS)})`).catch(() => null);
  if (!got || !got.pay) return false;
  const known = ORDER_HOSTS.includes(host) || /checkout|order/i.test(url);
  return got.marks >= (known ? 1 : 2);
}

async function orderPage(buyer: Buyer): Promise<Page | null> {
  for (const p of buyer.pages()) if (await isOrder(p)) return p;
  return null;
}

/**
 * 주문서에 도착했는가. 새 창으로 열릴 수도 있어 떠 있는 페이지를 다 본다. → [도착, 사유]
 * 가는 길에 봇 확인이 뜨면 사람을 기다리고, 마치면 기다리는 시간을 새로 센다.
 */
async function arrived(buyer: Buyer, timeout: number, bot: BotWait): Promise<[boolean, string | null]> {
  let deadline = Date.now() + timeout * 1000;
  let nextBotLook = 0;
  while (Date.now() < deadline) {
    // 담기 실패·한도 초과·구매 불가는 전부 alert 로 온다 (Order.js 의 callAddCart).
    const alert = buyer.alertText();
    if (alert) return [false, `사이트가 알렸습니다 — ${alert}`];
    if (buyer.isGone) return [false, "창이 닫혔습니다"];
    if (buyer.pages().some((p) => atLogin(p.url()))) return [false, SESSION_DEAD];
    const order = await orderPage(buyer);
    if (order) {
      buyer.page = order;
      log.info(`주문서에 도착했습니다 — ${order.url().split("?")[0]}`);
      return [true, null];
    }
    if (Date.now() >= nextBotLook) {
      nextBotLook = Date.now() + 1000;
      for (const p of buyer.pages()) {
        if (!(await botCheckOn(p))) continue;
        if (!(await waitHuman(p, bot.seconds, bot.notify))) return [false, BOT_CHECK_SAID];
        deadline = Date.now() + timeout * 1000;
      }
    }
    await sleep(250);
  }
  return [false, `구매하기를 눌렀지만 주문서로 넘어가지 않았습니다 (현재: ${buyer.page.url()})`];
}

/**
 * 상품 페이지를 열고 구매하기부터 주문서까지 누른다. → [주문서까지 갔는가, 사유]
 * 창은 어떻게 끝나든 남긴다. 어디서 멈췄는지 사람이 봐야 판단이 된다.
 */
export async function buyOnPage(
  buyer: Buyer, url: string,
  opts: { option?: string; ea?: number; timeout?: number; bot?: BotWait } = {},
): Promise<[boolean, string | null]> {
  const timeout = opts.timeout ?? 20;
  const bot = opts.bot ?? { seconds: 300 };
  const blocked = await openItem(buyer, url, timeout, bot);
  if (blocked) return [false, blocked];
  const bad = await landed(buyer, timeout);
  if (bad) return [false, bad];

  if (opts.option) {
    const reason = await pickOption(buyer, opts.option, timeout);
    if (reason) return [false, reason];
  }
  const ea = opts.ea ?? 1;
  if (ea > 1) {
    if (opts.option) log.warn("옵션 상품은 수량을 옵션 줄에서 정해야 해서 건드리지 않습니다 — 1개로 갑니다");
    else await setQuantity(buyer, ea);
  }

  // **한 번만 누른다.** 사이트는 담는 중에 또 누르면 "장바구니에 담는 중입니다" alert 를 띄운다.
  if (!(await pressMarked(buyer.page.mainFrame(), BUY_SELECTOR))) return [false, "구매하기를 누르지 못했습니다"];
  log.debug("구매하기를 눌렀습니다 — 주문서를 기다립니다.");
  return arrived(buyer, timeout, bot);
}

// ---------------------------------------------------------------------------
// 주문서에서
// ---------------------------------------------------------------------------

/** 주문서 위에 서 있는가. 아니면 사유. **엉뚱한 화면에서 누르는 것이 제일 나쁜 경우다.** */
async function standingOnOrder(buyer: Buyer): Promise<string | null> {
  if (buyer.isGone) return "창이 닫혔습니다";
  if (!buyer.page.isClosed() && (await isOrder(buyer.page))) return null;
  const order = await orderPage(buyer);
  if (order) {
    buyer.page = order;
    return null;
  }
  return `주문서가 아닙니다 (현재: ${buyer.page.isClosed() ? "닫힘" : buyer.page.url()})`;
}

/** 필수 동의만 체크한다. → 사유 (문제없으면 null) */
export async function agreeHere(buyer: Buyer): Promise<string | null> {
  const away = await standingOnOrder(buyer);
  if (away) return `${away} — 동의를 건드리지 않았습니다`;
  let got: [string[], string[]];
  try {
    got = await js<[string[], string[]]>(buyer.page, AGREE_SRC);
  } catch (e) {
    return `동의 항목을 보다 오류: ${(e as Error).message.split("\n")[0]}`;
  }
  const alert = buyer.alertText();
  if (alert) return `동의를 체크하는데 사이트가 알렸습니다 — ${alert}`;
  const [ticked, left] = got;
  if (ticked.length) log.info(`필수 동의 ${ticked.length}개를 체크했습니다: ${ticked.join(" / ")}`);
  else log.debug("체크할 필수 동의를 못 찾았습니다 (없거나 이미 되어 있습니다).");
  return left.length ? `동의 항목을 체크하지 못했습니다 (${left.join(" / ")})` : null;
}

export const PAY_METHOD_MISSING = "결제수단을 못 골랐습니다";

/**
 * 결제수단을 고른다. 한 줄이 한 단계이고, `|` 로 여러 이름을 적으면 그중 눌리는 것을 누른다.
 * **못 고르면 결제하기를 누르지 않는다** — 탭 이름만 믿고 엉뚱한 수단으로 가지 않는다.
 * 고른 뒤에는 mark 글자가 화면에 정말 떴는지 본다.
 */
export async function pickPayMethod(buyer: Buyer, steps: string[], mark: string): Promise<string | null> {
  const away = await standingOnOrder(buyer);
  if (away) return away;
  for (const step of steps) {
    const names = step.split("|").map((s) => s.trim()).filter(Boolean);
    let hit: string | null = null;
    for (const name of names) {
      if ((await clickText(buyer.page, name, 4, 2)) !== "none") {
        hit = name;
        break;
      }
    }
    const alert = buyer.alertText();
    if (alert) return `결제수단을 고르다 사이트가 알렸습니다 — ${alert}`;
    if (!hit) return `${PAY_METHOD_MISSING} — '${step}' 를 화면에서 못 찾았습니다`;
    log.info(`결제수단: '${hit}' 를 눌렀습니다`);
    await sleep(300);
  }
  if (mark) {
    const body = await bodyText(buyer.page);
    const want = mark.split("|").map((s) => s.trim()).filter(Boolean);
    if (!want.some((m) => body.includes(m))) return `${PAY_METHOD_MISSING} — 고른 뒤 화면에 '${mark}' 가 안 보입니다`;
  }
  return null;
}

// 결제하기를 누른 **다음** 화면의 신호.
const AUTH_MARKS = ["비밀번호", "스마일페이 인증", "인증번호", "결제 인증"];
const DONE_MARKS = ["주문이 완료", "주문완료", "결제가 완료", "결제완료"];
// 결제창으로 볼 만한 iframe 주소. 광고·추적 iframe 은 셀 것이 아니다.
const PAY_FRAME_RE = /pay|smile|auth|pg|kcp|inicis|nicepay|kakao|toss|payco|naver|card|bank/i;
export const PAID_ANYWAY = "결제가 끝났습니다 — 비밀번호 없이 넘어갔습니다";
export const PG_OPENED = "결제창(인증 화면)이 떴습니다";
export const PG_BLOCKED = "결제창이 뜨기 전에 사이트가 막았습니다";
export const PG_UNSEEN = "결제하기는 눌렀지만 결제창 신호를 못 봤습니다 — 창을 봐주세요";

const payFrames = (page: Page): number => page.frames().filter((f) => f !== page.mainFrame() && PAY_FRAME_RE.test(f.url())).length;
const marksIn = (body: string, marks: string[]): Set<string> => new Set(marks.filter((m) => body.includes(m)));

/**
 * 주문서에서 결제하기를 누른다. → [눌렀나, 무슨 일이 있었나]
 *
 * 결제창은 새 창·iframe·같은 페이지의 레이어 어느 것으로든 뜰 수 있다. 그래서 **새 창·새
 * 결제 iframe·alert·본문 글자를 다 본다.** 본문 글자는 누르기 전에 이미 있던 것은 세지 않는다.
 */
export async function payHere(buyer: Buyer, timeout = 20): Promise<[boolean, string]> {
  const away = await standingOnOrder(buyer);
  if (away) return [false, `${away} — 누르지 않았습니다`];
  const order = buyer.page;

  let found: { label: string; count: number } | null = null;
  try {
    found = await js(order, `${PAY_FIND_SRC}(${JSON.stringify(PAY_TEXT)})`);
  } catch (e) {
    log.debug(`결제 버튼을 찾는 중 오류: ${(e as Error).message.split("\n")[0]}`);
  }
  if (!found) return [false, `결제 버튼을 못 찾았습니다 ('${PAY_TEXT}')`];
  log.debug(`결제 버튼 — ${JSON.stringify(found.label)} (후보 ${found.count}개)`);

  const before = new Set(buyer.pages());
  const frames = payFrames(order);
  const firstBody = await bodyText(order);
  const hadAuth = marksIn(firstBody, AUTH_MARKS);
  const hadDone = marksIn(firstBody, DONE_MARKS);

  if (!(await pressMarked(order.mainFrame(), "[data-gm-pay]"))) return [false, "결제 버튼을 누르지 못했습니다"];
  log.debug("결제 버튼을 눌렀습니다 — 결제창 신호를 기다립니다.");

  const deadline = Date.now() + Math.min(timeout, 15) * 1000;
  while (Date.now() < deadline) {
    const alert = buyer.alertText();
    if (alert) return [true, `${PG_BLOCKED} — ${alert}`];
    if (buyer.isGone) return [true, "눌렀지만 창이 사라졌습니다"];
    if (buyer.pages().some((p) => !before.has(p))) {
      log.debug("결제창이 새 창으로 떴습니다.");
      return [true, PG_OPENED];
    }
    if (!order.isClosed() && payFrames(order) > frames) {
      log.debug("결제창이 이 창에 iframe 으로 얹혔습니다.");
      return [true, PG_OPENED];
    }
    const body = await bodyText(order);
    if (DONE_MARKS.some((m) => !hadDone.has(m) && body.includes(m))) return [true, PAID_ANYWAY];
    const auth = AUTH_MARKS.find((m) => !hadAuth.has(m) && body.includes(m));
    if (auth) {
      log.debug(`결제창이 이 페이지에 떴습니다 ('${auth}').`);
      return [true, PG_OPENED];
    }
    await sleep(250);
  }
  return [true, PG_UNSEEN];
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

/**
 * 떠 있는 창을 **전부**, 창마다 프레임을 전부 돌며 눌릴 만한 것을 적는다. → 적었으면 true
 * 주문서는 마크업을 남기지 않는다 — 배송지·받는 사람이 글자로 박혀 있다. 그 밖의 화면(결제창·
 * 자판)은 마크업까지 남긴다. 자판을 읽을 수 있었는지도 적는다(pin.ts 가 보는 그대로).
 */
export async function dumpPayment(buyer: Buyer, path: string): Promise<boolean> {
  const lines: string[] = [`# G마켓 결제하기 뒤 받아적기 (naver/ts gmarket · puppeteer) — ${new Date().toISOString()}`];
  const html: string[] = [];
  const pages = buyer.pages();
  if (!pages.length) {
    log.warn("창이 없어 받아 적지 못했습니다.");
    return false;
  }
  for (const [n, page] of pages.entries()) {
    const tag = page === buyer.first ? `창 ${n} (처음 연 창)` : `창 ${n}`;
    const orderish = await isOrder(page);
    for (const [m, frame] of page.frames().entries()) {
      const where = frame.url();
      let found: string[];
      try {
        found = await js<string[]>(frame, DUMP_SRC);
      } catch (e) {
        lines.push(`\n[${tag} · frame ${m}] 읽지 못함: ${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      if (!found.length && m > 0) continue; // 빈 광고 iframe
      lines.push(`\n[${tag} · frame ${m}] ${where}${orderish && m === 0 ? "  (주문서)" : ""}  (${found.length}개)`);
      lines.push(...found.map((item) => `  ${item}`));
      try {
        const pad = await js<[string, unknown[], boolean, string] | null>(frame, KEYPAD_SRC);
        lines.push(pad
          ? `  [자판 읽기] ${pad[0]} — 키 ${pad[1]?.length ?? 0}개 · 확인 키 ${pad[2] ? "있음" : "없음"} · ${String(pad[3]).slice(0, 200)}`
          : "  [자판 읽기] 없음 — 자판으로 안 보입니다");
      } catch (e) {
        lines.push(`  [자판 읽기] 실패: ${(e as Error).message.split("\n")[0]}`);
      }
      // 주문서 본문은 빼고, 결제창으로 보이는 창·iframe 만 마크업까지 남긴다.
      const worth = m === 0 ? !orderish && !where.includes(ITEM_HOST) : PAY_FRAME_RE.test(where);
      if (worth) {
        const body = await js<string>(frame, "document.body ? document.body.outerHTML : ''").catch(() => "");
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
