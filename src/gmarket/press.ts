/**
 * browser.ts 와 pin.ts 가 같이 쓰는 조각 — 퍼피티어 판. (스마트스토어 판 ../press.ts 의 짝)
 * 서로를 들이면 모듈이 서는 순서가 꼬여서 여기로 뺐다.
 *
 * 페이지 안 조각(HELPERS_JS)은 그쪽 것을 그대로 쓴다. 브라우저와 상관없는 자바스크립트다.
 */
import type { ElementHandle, Frame, Page } from "puppeteer";
import { log, sleep } from "../log.js";
import { HELPERS_JS, type Pressed } from "../press.js";

export { HELPERS_JS, type Pressed };

/**
 * 페이지(프레임) 안에서 **문자열**을 돌려 값을 받는다.
 *
 * 함수를 넘기면 tsx 가 이름표(__name)를 붙여 브라우저에서 터지는 일이 있어서(스마트스토어
 * 판에서 겪었다) 문자열로 넘긴다. 퍼피티어는 문자열 evaluate 의 값을 모른다(unknown) — 여기서
 * 한 번 매긴다. Promise 를 돌려주는 조각이면 퍼피티어가 끝날 때까지 기다려 준다.
 */
export async function js<T>(target: Page | Frame, src: string): Promise<T> {
  return (await target.evaluate(src)) as T;
}

// 그 자리를 화면 가운데로 굴려 놓고, 가운데에 **그것이** 맞는지 본다. 모달·덮개에 가려져
// 있으면 진짜 클릭은 덮개를 누른다 — 퍼피티어는 Playwright 처럼 가려짐을 따져 주지 않는다.
const HIT_SRC = (selector: string): string => `(function () {
var el = document.querySelector(${JSON.stringify(selector)});
if (!el) return null;
el.scrollIntoView({ block: "center", inline: "center" });
var r = el.getBoundingClientRect();
if (r.width <= 0 || r.height <= 0) return false;
var top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
if (!top) return false;
if (top === el || el.contains(top)) return true;
// 라벨로 덮어 꾸민 체크박스 — 라벨을 눌러도 그 체크박스가 눌린다.
var lab = top.closest ? top.closest("label") : null;
return !!lab && lab.control === el;
})()`;

const JS_CLICK_SRC = (selector: string): string =>
  `(function () { var el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`;

/**
 * 표시(data-gm-*)를 단 것을 누른다. → 눌렀으면 true
 *
 * 진짜 클릭이 먼저다 — 자바스크립트로 부른 click 은 isTrusted 가 false 라 창을 여는
 * 버튼이면 크롬이 막는다. 대신 가려져 있거나(덮개) 크기가 없으면(숨긴 체크박스) 자바스크립트로 누른다.
 */
export async function pressMarked(frame: Frame, selector: string): Promise<boolean> {
  let el: ElementHandle<Element> | null = null;
  try {
    el = await frame.$(selector);
    if (!el) return false;
    // 막 그려진 것은 한 박자 늦게 자리를 잡는다. 한 번만 더 본다.
    let hit = await js<boolean | null>(frame, HIT_SRC(selector));
    if (hit === false) {
      await sleep(300);
      hit = await js<boolean | null>(frame, HIT_SRC(selector));
    }
    if (hit === null) return false;
    if (hit) {
      try {
        await el.click();
        return true;
      } catch (e) {
        log.debug(`진짜 클릭이 안 됩니다 (${(e as Error).message.split("\n")[0]?.slice(0, 80)}). 자바스크립트로 누릅니다.`);
      }
    } else {
      log.debug(`'${selector}' 가 가려져 있거나 크기가 없습니다. 자바스크립트로 누릅니다.`);
    }
    return await js<boolean>(frame, JS_CLICK_SRC(selector));
  } catch (e) {
    log.debug(`'${selector}' 를 못 눌렀습니다: ${(e as Error).message.split("\n")[0]}`);
    return false;
  } finally {
    await el?.dispose().catch(() => undefined);
  }
}
