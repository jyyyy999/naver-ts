/**
 * 네이버페이 간편결제 비밀번호 자판을 읽어 누른다.
 *
 * aio/node/src/naver/pin.ts 를 Playwright 로 옮긴 것이다. 그쪽은 bnkr-test 에서 반다이남코몰
 * 결제 중 이 자판을 만나(pay.naver.com/authentication/pw/check) 여섯 자리를 다 넣는 데까지
 * 갔다. **자판 읽기(스프라이트 → 숫자)는 한 글자도 바꾸지 않았다** — 거기서 여러 번 틀려
 * 가며 맞춘 것이다. 바꾼 것은 하나, 읽은 키에 `data-nts-key` 표시를 달아 Playwright 가 그
 * 표시로 누르게 한 것뿐이다.
 *
 * **비밀번호 값은 어디에도 적지 않는다.** 로그에는 자릿수만 남는다. 틀리면 재시도하지
 * 않는다 — 몇 번 틀리면 결제가 잠기니까, 사람이 보게 남기고 물러난다.
 */
import type { Frame, Page } from "playwright";
import type { Buyer } from "./browser.js";
import { log, sleep } from "./log.js";
import { HELPERS_JS, pressMarked, type Pressed } from "./press.js";

// 자판은 **매 결제마다 숫자 위치가 바뀌고**, 숫자는 글자가 아니라 스프라이트 그림이다.
// 그림을 잘라 12×16 그물로 줄이고, 고정 본보기 + 여러 글꼴의 투표로 숫자를 맞춘다.
// → [상태, [[숫자, x, y]…], 확인 키가 있나, 디버그] | false
export const KEYPAD_SRC = `(function () {
${HELPERS_JS}
Array.prototype.slice.call(document.querySelectorAll("[data-nts-key], [data-nts-confirm]")).forEach(function (el) {
  el.removeAttribute("data-nts-key");
  el.removeAttribute("data-nts-confirm");
});
var CW = 12, CH = 16;
var ORDER = "1482967350";
var TEMPLATES = [
  "A/D/P//P8PwPAPAPAPAPAPAPAPAPAPAP",
  "A8A8B8BsDMHMGMOMcMYM4M////AMAMAM",
  "DwP8PecOcGcGOOH4P8eO4H4H4HcPP+H4",
  "HwP8f+4H4HAHAOAOAcA4DwHgPAeA////",
  "GAfAfg5wwwwwwxxxfxfxOwAwwwZgfgPA",
  "DwH8P+cHYA4A78/++P8H4H4HcHOPP+H4",
  "//////AHAOAOAcA4A4BwBwDgDAHAHAOA",
  "DwH8f+cPYHAGAOD8D8APAHAH4HcPP+H8",
  "f+f+f+cA4A4A78/+8HAHAH4H4HcPf+H4",
  "Hgf4/84ewOwPgPgPgHgHwPwOwO4c/8Pw",
];
var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function tplBits() {
  var out = [];
  for (var i = 0; i < TEMPLATES.length; i++) {
    var s = TEMPLATES[i], bits = [];
    for (var j = 0; j < s.length; j++) {
      var v = B64CHARS.indexOf(s[j]);
      for (var k = 5; k >= 0; k--) bits.push((v >> k) & 1);
    }
    out.push(bits);
  }
  return out;
}
var TPL = tplBits();
function handles(el) {
  var tag = el.tagName;
  if (tag === "A" || tag === "BUTTON" || tag === "LABEL" || tag === "INPUT") return true;
  if (el.onclick || el.getAttribute("onclick") || el.getAttribute("href")) return true;
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
  var all = root ? root.querySelectorAll("*") : document.querySelectorAll("*");
  Array.prototype.slice.call(all).forEach(function (el) {
    if (confirm) return;
    if (!visible(el)) return;
    var text = (el.textContent || "").trim();
    if (text !== "확인") return;
    if (Array.prototype.slice.call(el.querySelectorAll("*")).some(function (kid) {
      return visible(kid) && (kid.textContent || "").trim() === "확인";
    })) return;
    confirm = resolve(el) || el;
  });
  return confirm;
}
var keyboard = document.getElementById("keyboard");
if (!keyboard) {
  var tbl = document.querySelector("table.SecureKeyboard_keyboard, .SecureKeyboard_keyboard");
  if (tbl) keyboard = tbl.parentElement;
}
if (!keyboard) return false;
var spans = Array.prototype.slice.call(keyboard.querySelectorAll("span"))
  .filter(function (s) {
    var bg = s.style && s.style.backgroundImage;
    return bg && bg.indexOf("data:image") !== -1;
  });
if (spans.length < 9) return false;
var CACHE = window.__npaySpriteCache || (window.__npaySpriteCache = {});
var spriteUrl = spans[0].style.backgroundImage.replace(/^url\\(["']?/, "").replace(/["']?\\)$/, "");
var img = CACHE[spriteUrl];
if (!img) {
  img = new Image();
  img.src = spriteUrl;
  var t0 = Date.now();
  while (!img.complete && Date.now() - t0 < 2000) { }
  if (!img.complete || !img.width) return false;
  CACHE[spriteUrl] = img;
}
var canvas = document.createElement("canvas");
canvas.width = img.width; canvas.height = img.height;
var ctx = canvas.getContext("2d");
ctx.drawImage(img, 0, 0);
var px = ctx.getImageData(0, 0, img.width, img.height).data;
var W = img.width, H = img.height;
function ink(x, y) {
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  return px[(y * W + x) * 4 + 3] > 100;
}
function fingerprint(sx, sy, sw, sh) {
  var minX = sx + sw, minY = sy + sh, maxX = sx, maxY = sy, found = false;
  for (var y = sy; y < sy + sh; y++) for (var x = sx; x < sx + sw; x++) {
    if (ink(x, y)) {
      found = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!found) return null;
  var bits = [];
  for (var r = 0; r < CH; r++) {
    var y0c = minY + Math.floor((maxY - minY + 1) * r / CH);
    var y1c = minY + Math.floor((maxY - minY + 1) * (r + 1) / CH) - 1;
    for (var c = 0; c < CW; c++) {
      var x0c = minX + Math.floor((maxX - minX + 1) * c / CW);
      var x1c = minX + Math.floor((maxX - minX + 1) * (c + 1) / CW) - 1;
      var tot = 0, cnt = 0;
      for (var y = y0c; y <= y1c; y++) for (var x = x0c; x <= x1c; x++) { tot++; if (ink(x, y)) cnt++; }
      bits.push(tot > 0 && cnt / tot >= 0.35 ? 1 : 0);
    }
  }
  return bits;
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
    if (tot > 0) {
      var ratio = same / tot;
      if (ratio > best) best = ratio;
    }
  }
  return best;
}
var FONT_VOTERS = ["Arial Black", "Arial", "Malgun Gothic", "Segoe UI", "Arial Rounded MT Bold"];
var REF_CACHE = window.__npayFontRefs || (window.__npayFontRefs = {});
function refBits(name, ch) {
  var key = name + "/" + ch;
  if (REF_CACHE[key]) return REF_CACHE[key];
  var c = document.createElement("canvas");
  c.width = 96; c.height = 132;
  var x = c.getContext("2d");
  x.clearRect(0, 0, 96, 132);
  x.font = "600 58px " + name;
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillStyle = "#000";
  x.fillText(ch, 48, 68);
  var d = x.getImageData(0, 0, 96, 132).data;
  var a = [];
  for (var i = 0; i < 96 * 132; i++) a.push(d[i * 4 + 3]);
  var minX = 96, minY = 132, maxX = 0, maxY = 0, found = false;
  for (var y = 0; y < 132; y++) for (var xx = 0; xx < 96; xx++) {
    if (a[y * 96 + xx] > 100) {
      found = true;
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!found) { REF_CACHE[key] = null; return null; }
  var bits = [];
  for (var r = 0; r < CH; r++) {
    var y0c = minY + Math.floor((maxY - minY + 1) * r / CH);
    var y1c = minY + Math.floor((maxY - minY + 1) * (r + 1) / CH) - 1;
    for (var c2 = 0; c2 < CW; c2++) {
      var x0c = minX + Math.floor((maxX - minX + 1) * c2 / CW);
      var x1c = minX + Math.floor((maxX - minX + 1) * (c2 + 1) / CW) - 1;
      var tot = 0, cnt = 0;
      for (var y = y0c; y <= y1c; y++) for (var xx = x0c; xx <= x1c; xx++) { tot++; if (a[y * 96 + xx] > 100) cnt++; }
      bits.push(tot > 0 && cnt / tot >= 0.35 ? 1 : 0);
    }
  }
  REF_CACHE[key] = bits;
  return bits;
}
function classify(bits) {
  var totals = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  var tBest = -1, tV = -1, tSecond = -1;
  for (var t = 0; t < TPL.length; t++) {
    var v = compareBits(bits, TPL[t]);
    if (v > tV) { tSecond = tV; tV = v; tBest = t; }
    else if (v > tSecond) { tSecond = v; }
  }
  totals[Number(ORDER[tBest])] += tV;
  for (var f = 0; f < FONT_VOTERS.length; f++) {
    var name = FONT_VOTERS[f];
    var best = -1, bv = -1;
    for (var d = 0; d <= 9; d++) {
      var rb = refBits(name, String(d));
      if (!rb) continue;
      var v2 = compareBits(bits, rb);
      if (v2 > bv) { bv = v2; best = d; }
    }
    if (best >= 0) totals[best] += bv;
  }
  var win = 0;
  for (var d = 1; d <= 9; d++) if (totals[d] > totals[win]) win = d;
  var sorted = totals.slice().sort(function (a, b) { return b - a; });
  return { digit: String(win), score: sorted[0], next: sorted[1] };
}
var table = [];
var debug = [];
spans.forEach(function (span) {
  var btn = resolve(span);
  if (!btn) return;
  var cs = getComputedStyle(span);
  var mPos = cs.backgroundPosition.split(/\\s+/);
  var px0 = parseFloat(mPos[0]), py0 = parseFloat(mPos[1]);
  var sw = span.offsetWidth || 0, sh = span.offsetHeight || 0;
  var sx = -px0, sy = -py0, fw = sw, fh = sh;
  if (isNaN(px0) || isNaN(py0) || !sw || !sh) {
    debug.push("pos=" + cs.backgroundPosition + " size=" + cs.backgroundSize);
    return;
  }
  var mSize = cs.backgroundSize.split(/\\s+/);
  var sxw = parseFloat(mSize[0]), syh = parseFloat(mSize[1]);
  if (!isNaN(sxw) && !isNaN(syh) && sxw > 0 && syh > 0) {
    sx = -px0 * (W / sxw); fw = sw * (W / sxw);
    sy = -py0 * (H / syh); fh = sh * (H / syh);
  }
  var bits = fingerprint(sx, sy, fw, fh);
  if (!bits) return;
  var m = classify(bits);
  // 누를 자리에 표시를 단다. Playwright 가 이 표시로 누른다.
  btn.setAttribute("data-nts-key", m.digit);
  var r = btn.getBoundingClientRect();
  table.push([m.digit, Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
  debug.push(m.digit + "@" + Math.round(sx) + "," + Math.round(sy) + ":" +
    m.score.toFixed(2) + "/" + m.next.toFixed(2));
});
if (table.length !== 10) return ["odd", table, false, "keys=" + table.length + " " + debug.join(" ")];
var seenD = {};
table.forEach(function (e) { seenD[e[0]] = true; });
for (var d = 0; d < 10; d++) {
  if (!seenD[String(d)]) return ["odd", table, false, "missing " + d + " " + debug.join(" ")];
}
var confirm = findConfirm(keyboard);
if (confirm) confirm.setAttribute("data-nts-confirm", "1");
return ["found", table, !!confirm, debug.join(" ")];
})()`;

// 비밀번호가 틀렸을 때 자판 화면이 내미는 말. 보이면 물러나 사람에게 맡긴다.
const PIN_ERROR_SRC =
  `/비밀번호가 일치하지|비밀번호가 올바르지|비밀번호를 다시|간편비밀번호가 일치/.test(document.body ? document.body.innerText || "" : "")`;

// 채워진 비밀번호 점 개수. "Password_dot" 중 "Password_on" 이 붙은 것만 센다.
const DOTS_SRC = `(function () {
var n = 0;
Array.prototype.slice.call(document.querySelectorAll('[class*="Password_dot"]')).forEach(function (el) {
  if ((el.className || "").indexOf("Password_on") !== -1) n++;
});
return n;
})()`;

type KeypadHit = ["found" | "odd", [string, number, number][], boolean, string];

// 인증 화면의 주소에 붙는 자국. 이 프레임을 먼저 뒤진다 — 밑에 깔린 주문서에도 "확인" 이 있다.
const AUTH_MARK = "/authentication/";

/** 떠 있는 모든 창의 모든 프레임. 인증 화면 쪽을 앞에 세운다. */
function framesAuthFirst(buyer: Buyer): Frame[] {
  const all = buyer.pages().flatMap((p) => p.frames());
  const foreign = (f: Frame): boolean => f.url().includes(AUTH_MARK) || !f.url().includes("orders.pay.naver.com");
  return [...all.filter(foreign), ...all.filter((f) => !foreign(f))];
}

/** 프레임을 차례로 뒤져 참을 주는 첫 결과를 돌려준다. */
async function firstHit<T>(buyer: Buyer, src: string, ok: (v: T) => boolean): Promise<[T, Frame] | null> {
  for (const frame of framesAuthFirst(buyer)) {
    try {
      const got = await frame.evaluate<T>(src);
      if (ok(got)) return [got, frame];
    } catch {
      // 프레임이 갈렸다. 다음 것을 본다.
    }
  }
  return null;
}

const readKeypad = (buyer: Buyer): Promise<[KeypadHit, Frame] | null> =>
  firstHit<KeypadHit | false>(buyer, KEYPAD_SRC, (v) => !!v) as Promise<[KeypadHit, Frame] | null>;

/** 지금 어느 창·프레임에든 비밀번호 자판이 떠 있는가. */
export async function keypadUp(buyer: Buyer): Promise<boolean> {
  return (await readKeypad(buyer)) !== null;
}

/** 프레임 안 좌표를 그 창의 좌표로. iframe 이 겹겹이면 겹마다 더한다. */
async function pageCoords(frame: Frame, x: number, y: number): Promise<[Page, number, number] | null> {
  let dx = 0;
  let dy = 0;
  for (let f: Frame | null = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const box = await (await f.frameElement()).boundingBox();
    if (!box) return null;
    dx += box.x;
    dy += box.y;
  }
  return [frame.page(), x + dx, y + dy];
}

async function waitDots(buyer: Buyer, expect: number, timeoutMs = 1500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await firstHit<number>(buyer, DOTS_SRC, (n) => n === expect)) return true;
    await sleep(150);
  }
  return false;
}

/**
 * 간편결제 비밀번호 자판을 읽어 차례로 누른다. → "ok" / "quiet" / "none"
 *
 * **누를 자리마다 자판을 다시 읽고, 누를 때마다 점 개수로 확인한다.** 누를 때마다 숫자
 * 위치가 바뀔 수 있어서, 처음 읽은 표를 여섯 자리 내내 쓰면 갈린 화면의 키를 누르게 된다.
 * 표시로 못 누르면 방금 읽은 좌표로 누른다.
 */
export async function enterPin(buyer: Buyer, pin: string, timeout: number): Promise<Pressed> {
  const digits = (pin || "").replace(/\D/g, "");
  if (!digits) return "none";
  if (digits.length !== 6) log.warn(`간편결제 비밀번호가 ${digits.length}자리입니다. 네이버페이는 보통 6자리입니다.`);

  const deadline = Date.now() + timeout * 1000;
  let typed = 0;
  while (typed < digits.length) {
    const ch = digits[typed]!;
    let done = false;
    while (Date.now() < deadline && !done) {
      const got = await readKeypad(buyer);
      if (!got) {
        await sleep(400);
        continue;
      }
      const [[status, table, , info], frame] = got;
      if (status !== "found") {
        log.warn(`자판을 읽었는데 숫자가 어긋납니다 (${info || "?"}). 창을 확인해 주세요.`);
        return "none";
      }
      log.debug(`자판(${typed + 1}번째 자리): ${info}`);
      const entry = table.find((e) => e[0] === ch);
      if (!entry) return "none";

      if (!(await pressMarked(frame, `[data-nts-key="${ch}"]`))) {
        const at = await pageCoords(frame, entry[1], entry[2]).catch(() => null);
        if (at) {
          log.debug(`표시로 못 눌러 좌표(${at[1]},${at[2]})로 누릅니다.`);
          await at[0].mouse.click(at[1], at[2]).catch(() => undefined);
        }
      }
      if (await waitDots(buyer, typed + 1)) done = true;
      else {
        log.debug(`${typed + 1}번째 자리를 눌렀는데 점이 안 늘었습니다. 다시 읽습니다.`);
        await sleep(400);
      }
    }
    if (!done) break;
    typed += 1;
  }

  if (typed === 0) {
    log.warn("간편결제 비밀번호 자판을 찾지 못했습니다.");
    return "none";
  }
  if (typed < digits.length) {
    log.warn(`자판 키를 다 누르지 못했습니다 — ${typed}/${digits.length}자리.`);
    return "quiet";
  }
  log.info(`간편결제 비밀번호를 입력했습니다 (${digits.length}자리)`);

  // 틀린 비밀번호는 마지막 자리에서 이미 말해 줄 수 있다. 확인을 누르기 전에 본다.
  await sleep(700);
  if (await firstHit<boolean>(buyer, PIN_ERROR_SRC, (v) => v === true)) return "quiet";

  const still = await readKeypad(buyer);
  if (still && still[0][2]) {
    log.debug("자판의 확인 키를 누릅니다.");
    await pressMarked(still[1], "[data-nts-confirm]");
    await sleep(800);
    if (await firstHit<boolean>(buyer, PIN_ERROR_SRC, (v) => v === true)) return "quiet";
  }
  // 확인 키도 없는데 자판이 그대로면 어긋난 것이다.
  return (await readKeypad(buyer)) ? "quiet" : "ok";
}
