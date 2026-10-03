/**
 * G마켓 상품 페이지에서 재고·이름·가격·구매 한도·로그인 여부를 읽는다.
 *
 * 전부 서버가 그려 준 HTML 에 들어 있다 (gmarket_item_stock.py 가 보는 것과 같다).
 *
 *   "IsOutOfStock":true|false                      ← 재고는 이걸로 판정한다
 *   <strong class="price_real text__soldout">SOLD OUT</strong>
 *   "OrderPossibleCnt":1  "OrderLimitCntText":"30일당 1개 (구매가능 : 1개)"
 *   var GmarketHeaderComm = { … Member: { IsLogin: "0" … } }
 *
 * 로그인 여부가 상품 페이지에 박혀 오는 것이 쓸모 있다 — 감시하는 요청마다 세션이 살아
 * 있는지 덤으로 알 수 있다. 끊긴 것을 재고가 열린 순간에 알게 되면 늦다.
 */

export const itemUrl = (code: string): string => `https://item.gmarket.co.kr/Item?goodsCode=${code}`;

// 공유·모바일 주소도 goodsCode= 는 달고 온다 (대소문자는 제각각이다).
const CODE_RE = /goods[cC]ode=(\d+)/i;

/** 설정 한 줄(주소든 번호든)에서 상품번호를 꺼낸다. 못 알아보면 null. */
export function codeOf(entry: unknown): string | null {
  const s = String(entry ?? "").trim();
  if (/^\d{6,}$/.test(s)) return s;
  return CODE_RE.exec(s)?.[1] ?? null;
}

/** 복사해 둔 것 중에서 상품 주소(또는 번호)를 골라낸다. */
export function urlFrom(text: string): string {
  const code = codeOf(text) ?? /\b\d{9,12}\b/.exec(text)?.[0] ?? null;
  if (!code) throw new Error(`G마켓 상품 주소를 알아보지 못했습니다: ${text.slice(0, 80)}`);
  return itemUrl(code);
}

export interface ItemInfo {
  code: string;
  url: string;
  name: string;
  inStock: boolean;
  price: number | null;
  /** 지금 이 계정이 살 수 있는 수. 0 이면 구매 한도를 다 쓴 것이다. 모르면 null. */
  possible: number | null;
  /** 한 번에(또는 기간당) 살 수 있는 수. */
  limit: number | null;
  limitText: string;
  /** 상품 페이지가 로그인한 사람에게 그려졌나. 세션 없이 읽었으면 false. */
  loggedIn: boolean | null;
  image: string | null;
}

const OOS_RE = /"IsOutOfStock"\s*:\s*(true|false)/;
const TITLE_RE = /<title>\s*G마켓\s*-\s*([\s\S]*?)\s*<\/title>/;
const NAME_RE = /"GoodsName"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const PRICE_RE = /class="price_real[^"]*">\s*([\d,]+)/;
const ORIGIN_RE = /"OriginPrice"\s*:\s*(\d+)/;
const POSSIBLE_RE = /"OrderPossibleCnt"\s*:\s*(\d+)/;
const LIMIT_RE = /"OrderLimitCnt"\s*:\s*(\d+)/;
const LIMIT_TEXT_RE = /"OrderLimitCntText"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const LOGIN_RE = /IsLogin\s*:\s*"(\d)"/;
const IMAGE_RE = /"ImageUrl"\s*:\s*"([^"]+)"/;

/** 재고 표시가 있는 상품 페이지인가. 막혔을 때 오는 화면에는 이게 없다. */
export const hasStock = (html: string): boolean => OOS_RE.test(html);

/**
 * Cloudflare 의 봇 확인(관리형 챌린지) 화면인가. 2026-09-26 밤부터 item.gmarket.co.kr 에 떴다.
 *
 *   HTTP 403 · <title>잠시만 기다리십시오…</title> · window._cf_chl_opt = {… cType: 'managed' …}
 *   challenges.cloudflare.com/turnstile · "고객님의 사이트 내 활동이 봇의 동작과 유사해 보입니다"
 *
 * 차단(403 "G마켓 - 쇼핑을 바꾸는 쇼핑")과 다르다 — 이건 **사람이 창에서 확인을 마치면** 풀린다.
 * 프로그램은 이걸 넘으려 하지 않는다. 알아보고, 물러나고, 사람을 기다린다.
 *
 * `/cdn-cgi/challenge-platform/` 만으로 보면 안 된다 — **멀쩡한 상품 페이지에도**
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` 가 박혀 온다 (Cloudflare 가 모든 페이지에 심는
 * 것이다). 처음 판이 그걸로 봐서 정상 페이지를 봇 확인으로 읽었다. 확인 화면에만 있는 것
 * (`_cf_chl_opt` · `orchestrate/chl_page` · turnstile · 안내 문구)으로 본다.
 */
export const looksLikeBotCheck = (html: string): boolean =>
  /_cf_chl_opt|\/challenge-platform\/h\/[a-z]\/orchestrate\/chl_page|challenges\.cloudflare\.com\/turnstile/.test(html) ||
  /봇 확인 절차|봇의 동작과 유사/.test(html);

function jsonString(raw: string | undefined): string {
  if (raw === undefined) return "";
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

const num = (raw: string | undefined): number | null => (raw === undefined ? null : Number(raw.replace(/,/g, "")));

export function parseItem(code: string, html: string): ItemInfo {
  const oos = OOS_RE.exec(html);
  if (!oos) throw new Error("상품 페이지에 품절 정보(IsOutOfStock)가 없습니다");
  const name = (TITLE_RE.exec(html)?.[1] ?? jsonString(NAME_RE.exec(html)?.[1])).trim() || `상품 ${code}`;
  const origin = num(ORIGIN_RE.exec(html)?.[1]);
  const login = LOGIN_RE.exec(html)?.[1];
  const image = IMAGE_RE.exec(html)?.[1] ?? null;
  return {
    code,
    url: itemUrl(code),
    name,
    inStock: oos[1] === "false",
    // 품절이면 price_real 자리에 SOLD OUT 이 온다. 그때는 원가도 0 이다.
    price: num(PRICE_RE.exec(html)?.[1]) ?? (origin ? origin : null),
    possible: num(POSSIBLE_RE.exec(html)?.[1]),
    limit: num(LIMIT_RE.exec(html)?.[1]),
    limitText: jsonString(LIMIT_TEXT_RE.exec(html)?.[1]),
    loggedIn: login === undefined ? null : login === "1",
    image: image ? (image.startsWith("//") ? `https:${image}` : image) : null,
  };
}

export const priceText = (price: number | null | undefined): string =>
  typeof price === "number" && price > 0 ? `${price.toLocaleString("ko-KR")}원` : "가격 미표기";

export const statusText = (info: ItemInfo): string => (info.inStock ? "구매 가능" : "품절");
