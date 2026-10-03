/**
 * 스마일페이 비밀번호 자판을 읽어 누른다.
 *
 * **이 자판을 아직 한 번도 못 봤다.** 로그인해야 가는 자리라 만들 때 들어가 볼 수 없었다.
 * 그래서 롯데온 판(aio/node/src/lotte-test/browser.ts 의 KEYPAD_JS)이 쓰는 **아무 자판이나
 * 읽는 방법**을 옮겼다.
 *
 *   1) 글자/속성 키 — 키마다 0-9 가 글자로 있거나 aria-label·data-* 에 박혀 있다
 *   2) 스프라이트 키 — 숫자가 그림(data:image 배경)이다. 잘라서 글꼴로 그려 견준다
 *
 * 어느 쪽이든 **0-9 가 한 자씩 다 있어야 자판이다.** 모자라거나 겹치면 누르지 않는다.
 * 네이버페이 판(../pin.ts)의 고정 본보기는 네이버 그림이라 못 쓰고, 글꼴 투표만 쓴다.
 *
 * **같은 자리를 두 번 누르지 않는다.** 롯데온 판이 데인 자리다 — 채워진 점을 잘못 읽어서
 * "안 눌렸다" 고 보고 같은 키를 또 누르다 틀린 비밀번호가 쌓였다. 여기서는 눌렀는데 점이
 * 안 늘면 다시 누르지 않고 물러난다. 점 자리를 아예 못 찾으면 확인 없이 차례로만 누른다.
 *
 * **비밀번호 값은 어디에도 적지 않는다.** 로그에는 자릿수만 남는다. 틀리면 재시도하지
 * 않는다 — 몇 번 틀리면 결제가 잠긴다.
 */
import type { Frame, Page } from "puppeteer";
import { log, sleep } from "../log.js";
import type { Buyer } from "./browser.js";
import { js, pressMarked, type Pressed } from "./press.js";

// → ["found"|"odd", [[숫자, x, y]…], 확인 키가 있나, 디버그] | null(자판 아님)
export const KEYPAD_SRC = `(function () {
function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}
function handles(el) {
  var tag = el.tagName;
  if (tag === "A" || tag === "BUTTON" || tag === "LABEL" || tag === "INPUT") return true;
  if (el.onclick || el.getAttribute("onclick") || el.getAttribute("href")) return true;
  if (el.getAttribute("role") === "button") return true;
  try {
    var book = window.jQuery && window.jQuery._data(el, "events");
    if (book && book.click) return true;
  } catch (e) {}
  return false;
}
function resolve(el) {
  if (handles(el)) return el;
  for (var up = el.parentElement; up && up !== document.body; up = up.parentElement) {
    if (handles(up)) return up;
  }
  return null;
}
function findConfirm(root) {
  var confirm = null;
  Array.prototype.slice.call(root.querySelectorAll("*")).forEach(function (el) {
    if (confirm || !visible(el)) return;
    var text = (el.textContent || "").trim();
    if (text !== "확인" && text !== "입력완료" && text !== "완료") return;
    if (Array.prototype.slice.call(el.querySelectorAll("*")).some(function (kid) {
      return visible(kid) && (kid.textContent || "").trim() === text;
    })) return;
    confirm = resolve(el) || el;
  });
  return confirm;
}
Array.prototype.slice.call(document.querySelectorAll("[data-gm-key], [data-gm-confirm]")).forEach(function (el) {
  el.removeAttribute("data-gm-key");
  el.removeAttribute("data-gm-confirm");
});

// --- 키가 말하는 숫자. 글자 먼저, 그다음 속성. ---
function keyDigit(el) {
  var text = (el.textContent || "").replace(/\\s+/g, "").trim();
  if (/^[0-9]$/.test(text)) return text;
  var attr = ((el.getAttribute("aria-label") || el.getAttribute("data-value") ||
               el.getAttribute("data-num") || el.getAttribute("data-key") ||
               el.getAttribute("data-digit") || el.getAttribute("title") || el.getAttribute("alt") || "") +
              // 값이 박힌 입력칸(스마일캐시 사용액 "0" 따위)이 숫자로 읽히는 것을 막는다.
              (el.tagName === "INPUT" && /button|submit/.test(el.getAttribute("type") || "")
                ? " " + (el.value || "") : "")).trim();
  var m = /(^|[^0-9])([0-9])([^0-9]|$)/.exec(attr);
  return m ? m[2] : null;
}
// 키다운 정도. 링크는 키가 아니다 — 롯데온 판에서 순위 목록의 <a><span>5</span>…</a> 를
// 키로 읽고 눌러 검색 페이지로 나간 적이 있다.
function keyish(btn) {
  var tag = btn.tagName;
  if (tag === "BUTTON") return 3;
  if (tag === "INPUT") {
    var kind = (btn.getAttribute("type") || "text").toLowerCase();
    return kind === "button" || kind === "submit" ? 2 : 0;
  }
  if (handles(btn)) return 1;
  return 0;
}
// 그릇 안에서 숫자마다 가장 키다운 것을 하나씩 모은다.
function collect(root) {
  var map = {};
  Array.prototype.slice.call(root.querySelectorAll(
    'button, a, [role="button"], input, span, div, li, td, label, img'
  )).forEach(function (el) {
    if (!visible(el)) return;
    var d = keyDigit(el);
    if (!d) return;
    var btn = resolve(el) || el;
    if (btn.tagName === "A" || keyish(btn) <= 0 || !root.contains(btn)) return;
    var old = map[d];
    if (!old || keyish(btn) > keyish(old)) map[d] = btn;
  });
  return map;
}
function full(map) {
  for (var d = 0; d <= 9; d++) if (!map[String(d)]) return false;
  return true;
}
function mark(byDigit, bowl, debug) {
  var table = [];
  for (var d = 0; d <= 9; d++) {
    var b = byDigit[String(d)], r = b.getBoundingClientRect();
    b.setAttribute("data-gm-key", String(d));
    table.push([String(d), Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  }
  var confirm = bowl ? findConfirm(bowl) : null;
  if (confirm) confirm.setAttribute("data-gm-confirm", "1");
  return ["found", table, !!confirm, debug];
}

// --- 1) 이름 붙은 그릇(keypad·keyboard·secure·pwd…) 중 0-9 를 다 품은 가장 안쪽 것. ---
// "pin" 은 이름에서 뺐다 — "shipping" 같은 딴 이름에 걸린다.
var bowl = null, byDigit = null;
Array.prototype.slice.call(document.querySelectorAll(
  '[class*="keypad" i],[class*="keyboard" i],[class*="secure" i],[class*="numkey" i],' +
  '[class*="pwd" i],[class*="password" i],[id*="keypad" i],[id*="keyboard" i],[id*="numkey" i]'
)).forEach(function (b) {
  if (!visible(b) || (bowl && !bowl.contains(b))) return;
  var m = collect(b);
  if (full(m)) { bowl = b; byDigit = m; }
});
if (bowl) return mark(byDigit, bowl, "글자 자판 bowl=" + (bowl.id || String(bowl.className).slice(0, 40)));

// --- 2) 이름이 없으면: 페이지 전체에서 모아 공통 조상을 그릇으로 삼는다. ---
byDigit = collect(document);
if (full(byDigit)) {
  var keys = [];
  for (var d0 = 0; d0 <= 9; d0++) keys.push(byDigit[String(d0)]);
  // 열 개 키가 한곳에 모여 있어야 자판이다. 화면을 가로질러 흩어져 있으면 페이지 여기저기의
  // 숫자를 모은 것이다.
  var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  keys.forEach(function (k) {
    var kr = k.getBoundingClientRect();
    minX = Math.min(minX, kr.left); minY = Math.min(minY, kr.top);
    maxX = Math.max(maxX, kr.right); maxY = Math.max(maxY, kr.bottom);
  });
  if (maxX - minX > window.innerWidth * 0.85 && maxY - minY > window.innerHeight * 0.85) {
    return ["odd", [], false, "키가 흩어져 있습니다 (" + Math.round(maxX - minX) + "x" + Math.round(maxY - minY) + "px)"];
  }
  for (var up = keys[0].parentElement; up && up !== document.documentElement; up = up.parentElement) {
    if (keys.every(function (k) { return up.contains(k); })) { bowl = up; break; }
  }
  if (bowl && bowl !== document.body) {
    return mark(byDigit, bowl, "글자 자판 bowl=" + (bowl.id || String(bowl.className || bowl.tagName).slice(0, 40)));
  }
}

// --- 스프라이트 자판. 숫자가 그림이다. ---
var spriteSpans = Array.prototype.slice.call(document.querySelectorAll("span, i, button, div"))
  .filter(function (s) {
    var bg = s.style && s.style.backgroundImage;
    return bg && bg.indexOf("data:image") !== -1 && visible(s);
  });
if (spriteSpans.length < 9) return null;
var spriteBowl = null;
for (var up2 = spriteSpans[0].parentElement; up2 && up2 !== document.documentElement; up2 = up2.parentElement) {
  if (spriteSpans.every(function (s) { return up2.contains(s); })) { spriteBowl = up2; break; }
}
if (!spriteBowl) return null;

var CACHE = window.__gmSpriteCache || (window.__gmSpriteCache = {});
var spriteUrl = spriteSpans[0].style.backgroundImage.replace(/^url\\(["']?/, "").replace(/["']?\\)$/, "");
var img = CACHE[spriteUrl];
if (!img) {
  img = new Image();
  img.src = spriteUrl;
  var t0 = Date.now();
  while (!img.complete && Date.now() - t0 < 2000) { /* 데이터 URL 은 곧 끝난다 */ }
  if (!img.complete || !img.width) return null;
  CACHE[spriteUrl] = img;
}
var canvas = document.createElement("canvas");
canvas.width = img.width; canvas.height = img.height;
var ctx = canvas.getContext("2d");
ctx.drawImage(img, 0, 0);
var px = ctx.getImageData(0, 0, img.width, img.height).data;
var W = img.width, H = img.height, CW = 12, CH = 16;
function ink(x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return px[(Math.floor(y) * W + Math.floor(x)) * 4 + 3] > 100;
}
function grid(get, minX, minY, maxX, maxY) {
  var bits = [];
  for (var r = 0; r < CH; r++) {
    var y0 = minY + Math.floor((maxY - minY + 1) * r / CH);
    var y1 = minY + Math.floor((maxY - minY + 1) * (r + 1) / CH) - 1;
    for (var c = 0; c < CW; c++) {
      var x0 = minX + Math.floor((maxX - minX + 1) * c / CW);
      var x1 = minX + Math.floor((maxX - minX + 1) * (c + 1) / CW) - 1;
      var tot = 0, cnt = 0;
      for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) { tot++; if (get(x, y)) cnt++; }
      bits.push(tot > 0 && cnt / tot >= 0.35 ? 1 : 0);
    }
  }
  return bits;
}
function fingerprint(sx, sy, sw, sh) {
  var minX = sx + sw, minY = sy + sh, maxX = sx, maxY = sy, found = false;
  for (var y = Math.floor(sy); y < sy + sh; y++) for (var x = Math.floor(sx); x < sx + sw; x++) {
    if (ink(x, y)) {
      found = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return found ? grid(ink, minX, minY, maxX, maxY) : null;
}
function compareBits(a, b) {
  var best = -1;
  for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
    var same = 0, tot = 0;
    for (var r = 0; r < CH; r++) for (var c = 0; c < CW; c++) {
      var rr = r + dy, cc = c + dx;
      if (rr < 0 || rr >= CH || cc < 0 || cc >= CW) continue;
      if (a[r * CW + c] === b[rr * CW + cc]) same++;
      tot++;
    }
    if (tot > 0 && same / tot > best) best = same / tot;
  }
  return best;
}
var FONT_VOTERS = ["Arial Black", "Arial", "Malgun Gothic", "Segoe UI", "Arial Rounded MT Bold"];
var REF = window.__gmFontRefs || (window.__gmFontRefs = {});
function refBits(name, ch) {
  var key = name + "/" + ch;
  if (key in REF) return REF[key];
  var c = document.createElement("canvas");
  c.width = 96; c.height = 132;
  var x = c.getContext("2d");
  x.font = "600 58px " + name;
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = "#000";
  x.fillText(ch, 48, 68);
  var d = x.getImageData(0, 0, 96, 132).data;
  function on(xx, yy) { return d[(yy * 96 + xx) * 4 + 3] > 100; }
  var minX = 96, minY = 132, maxX = 0, maxY = 0, found = false;
  for (var yy = 0; yy < 132; yy++) for (var xx = 0; xx < 96; xx++) {
    if (on(xx, yy)) {
      found = true;
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    }
  }
  REF[key] = found ? grid(on, minX, minY, maxX, maxY) : null;
  return REF[key];
}
function classify(bits) {
  var totals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  FONT_VOTERS.forEach(function (name) {
    var best = -1, bv = -1;
    for (var d = 0; d <= 9; d++) {
      var rb = refBits(name, String(d));
      if (!rb) continue;
      var v = compareBits(bits, rb);
      if (v > bv) { bv = v; best = d; }
    }
    if (best >= 0) totals[best] += bv;
  });
  var win = 0;
  for (var d2 = 1; d2 <= 9; d2++) if (totals[d2] > totals[win]) win = d2;
  var sorted = totals.slice().sort(function (a, b) { return b - a; });
  return { digit: String(win), score: sorted[0], next: sorted[1] };
}
var table2 = [], debug2 = [];
spriteSpans.forEach(function (span) {
  var btn = resolve(span);
  if (!btn) return;
  var cs = getComputedStyle(span);
  var pos = cs.backgroundPosition.split(/\\s+/);
  var px0 = parseFloat(pos[0]), py0 = parseFloat(pos[1]);
  var sw = span.offsetWidth || 0, sh = span.offsetHeight || 0;
  if (isNaN(px0) || isNaN(py0) || !sw || !sh) { debug2.push("pos=" + cs.backgroundPosition); return; }
  var sx = -px0, sy = -py0, fw = sw, fh = sh;
  var size = cs.backgroundSize.split(/\\s+/);
  var bw = parseFloat(size[0]), bh = parseFloat(size[1]);
  if (!isNaN(bw) && !isNaN(bh) && bw > 0 && bh > 0) {
    sx = -px0 * (W / bw); fw = sw * (W / bw);
    sy = -py0 * (H / bh); fh = sh * (H / bh);
  }
  var bits = fingerprint(sx, sy, fw, fh);
  if (!bits) return;
  var m = classify(bits);
  var r = btn.getBoundingClientRect();
  table2.push([m.digit, btn, Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  debug2.push(m.digit + "@" + Math.round(sx) + "," + Math.round(sy) + ":" + m.score.toFixed(2) + "/" + m.next.toFixed(2));
});
var seen = {};
table2.forEach(function (e) { seen[e[0]] = true; });
var missing = [];
for (var d3 = 0; d3 <= 9; d3++) if (!seen[String(d3)]) missing.push(d3);
if (table2.length !== 10 || missing.length) {
  return ["odd", table2.map(function (e) { return [e[0], e[2], e[3]]; }), false,
    "그림 자판 keys=" + table2.length + (missing.length ? " missing " + missing.join(",") : "") + " " + debug2.join(" ")];
}
var spriteKeys = {};
table2.forEach(function (e) { spriteKeys[e[0]] = e[1]; });
return mark(spriteKeys, spriteBowl, "그림 자판 " + debug2.join(" "));
})()`;

// 비밀번호가 틀렸을 때 자판 화면이 내미는 말. 보이면 물러나 사람에게 맡긴다.
const PIN_ERROR_SRC =
  `/비밀번호가 일치하지|비밀번호가 올바르지|비밀번호를 다시|비밀번호가 틀렸|잘못 입력|회 틀렸|회 잘못|재설정/.test(document.body ? document.body.innerText || "" : "")`;

/**
 * 채워진 비밀번호 칸 수. → [채워진 수, 칸이 있나] | null(이 프레임엔 칸이 없다)
 *
 * 점은 흔한 이름(dot·pwd·pass·pin·circle)에 채워짐 표시(on·fill·active…)가 붙는 꼴로 본다.
 * 입력칸은 **type=password 만** 본다 — 주문서의 스마일캐시·포인트 입력칸("0")이 점으로
 * 읽히면 첫 자리부터 거짓 성공한다 (롯데온 판에서 그랬다).
 */
const PROGRESS_SRC = `(function () {
function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none";
}
var filled = 0, seats = 0;
Array.prototype.slice.call(document.querySelectorAll("span, div, i, b, li, em, td")).forEach(function (el) {
  if (!visible(el)) return;
  var r = el.getBoundingClientRect();
  if (r.width > 60 || r.height > 60) return;
  var cls = String(el.className || "");
  if (!/(^|[\\s_-])(dot|dots|pwd|pass|password|pin|circle|bullet)([\\s_-]|$)/i.test(cls)) return;
  seats++;
  if (/(^|[\\s_-])(on|fill|filled|active|sel|selected|check|checked|input|typed|full)([\\s_-]|$)/i.test(cls)) filled++;
});
if (seats) return [filled, true];
var pw = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]')).filter(visible);
if (pw.length) {
  var n = 0;
  pw.forEach(function (i) { n = Math.max(n, String(i.value || "").length); });
  return [n, true];
}
return null;
})()`;

type KeypadHit = ["found" | "odd", [string, number, number][], boolean, string];

/**
 * 떠 있는 모든 창의 모든 프레임. **주문서가 아닌 것을 앞에 세운다** — 자판은 새 창이나
 * iframe 에 뜨고, 밑에 깔린 주문서에도 숫자 글자가 널려 있다.
 */
function framesPayFirst(buyer: Buyer): Frame[] {
  const all = buyer.pages().flatMap((p) => p.frames());
  const order = buyer.page;
  const underneath = (f: Frame): boolean => f === order.mainFrame();
  return [...all.filter((f) => !underneath(f)), ...all.filter(underneath)];
}

async function firstHit<T>(buyer: Buyer, src: string, ok: (v: T) => boolean): Promise<[T, Frame] | null> {
  for (const frame of framesPayFirst(buyer)) {
    try {
      const got = await js<T>(frame, src);
      if (ok(got)) return [got, frame];
    } catch {
      // 프레임이 갈렸다. 다음 것을 본다.
    }
  }
  return null;
}

const readKeypad = (buyer: Buyer): Promise<[KeypadHit, Frame] | null> =>
  firstHit<KeypadHit | null>(buyer, KEYPAD_SRC, (v) => !!v) as Promise<[KeypadHit, Frame] | null>;

/** 채워진 칸 수. 어느 프레임에도 칸이 없으면 null. */
async function progress(buyer: Buyer): Promise<number | null> {
  const hit = await firstHit<[number, boolean] | null>(buyer, PROGRESS_SRC, (v) => !!v);
  return hit?.[0]?.[0] ?? null;
}

/**
 * 프레임 안 좌표를 그 창의 좌표로. 퍼피티어의 boundingBox 는 **이미 맨 위 창 기준이다** —
 * iframe 이 겹겹이어도 제 iframe 자리 하나만 더한다 (겹마다 더하면 두 번 더한다).
 */
async function pageCoords(frame: Frame, x: number, y: number): Promise<[Page, number, number] | null> {
  if (!frame.parentFrame()) return [frame.page(), x, y];
  const holder = await frame.frameElement();
  const box = await holder?.boundingBox();
  await holder?.dispose().catch(() => undefined);
  if (!box) return null;
  return [frame.page(), x + box.x, y + box.y];
}

/** 지금 어느 창·프레임에든 비밀번호 자판이 떠 있는가. */
export async function keypadUp(buyer: Buyer): Promise<boolean> {
  const hit = await readKeypad(buyer);
  return !!hit && hit[0][0] === "found";
}

/**
 * 스마일페이 비밀번호 자판을 읽어 차례로 누른다. → "ok" / "quiet" / "none"
 *
 *   "ok"    다 넣었고 자판이 닫혔다
 *   "quiet" 넣다 말았거나, 다 넣었는데 자판이 그대로다 (틀렸거나 확인 화면이 더 있다)
 *   "none"  자판을 못 찾았다 (아무것도 안 눌렀다)
 *
 * 누를 자리마다 자판을 다시 읽는다 — 누를 때마다 숫자 자리가 바뀌는 자판이 있다.
 */
export async function enterPin(buyer: Buyer, pin: string, timeout: number): Promise<Pressed> {
  const digits = (pin || "").replace(/\D/g, "");
  if (!digits) return "none";
  if (digits.length !== 6) log.warn(`스마일페이 비밀번호가 ${digits.length}자리입니다. 보통 6자리입니다.`);

  const deadline = Date.now() + timeout * 1000;
  let typed = 0;
  let blind = false; // 점 자리를 못 찾아 확인 없이 누르는 중인가
  while (typed < digits.length) {
    const ch = digits[typed]!;
    let got: [KeypadHit, Frame] | null = null;
    while (Date.now() < deadline && !(got = await readKeypad(buyer))) await sleep(300);
    if (!got) break;
    const [[status, table, , info], frame] = got;
    if (status !== "found") {
      log.warn(`자판을 읽었는데 숫자가 어긋납니다 (${info.slice(0, 200) || "?"}). 창에서 직접 넣어주세요.`);
      return typed ? "quiet" : "none";
    }
    if (typed === 0) log.debug(`자판: ${info.slice(0, 300)}`);
    const entry = table.find((e) => e[0] === ch);
    if (!entry) return typed ? "quiet" : "none";

    const before = await progress(buyer);
    if (!(await pressMarked(frame, `[data-gm-key="${ch}"]`))) {
      const at = await pageCoords(frame, entry[1], entry[2]).catch(() => null);
      if (!at) return typed ? "quiet" : "none";
      log.debug(`표시로 못 눌러 좌표(${Math.round(at[1])},${Math.round(at[2])})로 누릅니다.`);
      await at[0].mouse.click(at[1], at[2]).catch(() => undefined);
    }

    if (before === null) {
      // 점 자리가 없다. 확인할 길이 없으니 한 박자 쉬고 다음 자리로 간다.
      if (!blind) log.debug("비밀번호 칸(점)을 못 찾아 확인 없이 차례로 누릅니다.");
      blind = true;
      await sleep(250);
    } else {
      const until = Date.now() + 1500;
      let now: number | null = before;
      while (Date.now() < until && (now = await progress(buyer)) === before) await sleep(120);
      // 점이 안 늘었다. **다시 누르지 않는다** — 눌렸는데 못 읽은 것이면 두 번 들어간다.
      if (now === before) {
        log.warn(`${typed + 1}번째 자리를 눌렀는데 칸이 안 늘었습니다 — 다시 누르지 않고 물러납니다.`);
        return "quiet";
      }
    }
    typed += 1;
  }

  if (typed === 0) {
    log.warn("스마일페이 비밀번호 자판을 찾지 못했습니다.");
    return "none";
  }
  if (typed < digits.length) {
    log.warn(`자판 키를 다 누르지 못했습니다 — ${typed}/${digits.length}자리.`);
    return "quiet";
  }
  log.info(`스마일페이 비밀번호를 입력했습니다 (${digits.length}자리)`);

  // 틀린 비밀번호는 마지막 자리에서 이미 말해 줄 수 있다. 확인을 누르기 전에 본다.
  await sleep(700);
  if (await firstHit<boolean>(buyer, PIN_ERROR_SRC, (v) => v === true)) return "quiet";

  const still = await readKeypad(buyer);
  if (still && still[0][0] === "found" && still[0][2]) {
    log.debug("자판의 확인 키를 누릅니다.");
    await pressMarked(still[1], "[data-gm-confirm]");
    await sleep(800);
    if (await firstHit<boolean>(buyer, PIN_ERROR_SRC, (v) => v === true)) return "quiet";
  }
  return (await keypadUp(buyer)) ? "quiet" : "ok";
}
