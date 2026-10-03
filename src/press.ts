/**
 * browser.ts 와 pin.ts 가 같이 쓰는 조각. 서로를 들이면 모듈이 서는 순서가 꼬여서
 * (한쪽 상수가 아직 안 선 채로 읽힌다) 여기로 뺐다.
 */
import type { Frame } from "playwright";
import { log } from "./log.js";

export type Pressed = "ok" | "quiet" | "none";

// 화면에 보이는가 · 보이는 글자 · 화면 상태 한 줄. aio 셀레니움 판의 VISIBLE_JS 그대로다.
export const HELPERS_JS = `
function visible(el) {
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
}
// 눈에 보이는 글자가 먼저다. title 은 툴팁이지 표시 글자가 아니다.
function label(el) {
  var text = (el.textContent || "").trim();
  if (text) return text;
  return (el.value || el.alt || el.getAttribute("title") || "").trim();
}
// 누른 게 먹혔는지 보는 자. 글자 수만 재면 체크박스가 켜진 것을 못 본다.
function sig() {
  var out = [location.href, (document.body.innerText || "").length,
             document.querySelectorAll("*").length];
  var fields = document.querySelectorAll("input, select, textarea"), a = "";
  for (var i = 0; i < fields.length; i++) {
    a += (fields[i].checked ? "1" : "0") + (fields[i].disabled ? "1" : "0") +
         String(fields[i].value || "").length + ",";
  }
  var acts = document.querySelectorAll("button, a"), b = "";
  for (var j = 0; j < acts.length; j++) {
    b += (acts[j].disabled ? "1" : "0") + String(acts[j].className || "") + ";";
  }
  return out.join("~") + "~" + a + "~" + b;
}
`;

/**
 * 표시(data-nts-*)를 단 것을 누른다. → 눌렀으면 true
 *
 * 진짜 클릭이 먼저다 — 자바스크립트로 부른 click 은 isTrusted 가 false 라 창을 여는
 * 버튼이면 크롬이 막는다. 대신 진짜 클릭은 가려진 것을 거부하므로(체크박스를 label 로
 * 덮어 꾸민 경우), 그때는 자바스크립트로 누른다.
 */
export async function pressMarked(frame: Frame, selector: string): Promise<boolean> {
  const loc = frame.locator(selector).first();
  try {
    await loc.click({ timeout: 2500 });
    return true;
  } catch (e) {
    log.debug(`진짜 클릭이 안 됩니다 (${(e as Error).message.split("\n")[0]?.slice(0, 80)}). 자바스크립트로 누릅니다.`);
  }
  try {
    await loc.evaluate("(el) => el.click()", undefined, { timeout: 1500 });
    return true;
  } catch (e) {
    log.debug(`자바스크립트로도 못 눌렀습니다: ${(e as Error).message.split("\n")[0]}`);
    return false;
  }
}
