import type { OptionRow, ProductInfo } from "./types.js";

// 네이버 __PRELOADED_STATE__ 는 예고 없이 모양이 바뀌는 비정형 JSON 이라 이 파일 안에서만 any 로 다룬다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const IN_STOCK_STATUSES = new Set(["SALE"]);

const PRODUCT_URL_RE = /https?:\/\/(?:brand|smartstore)\.naver\.com\/([^/]+)\/products\/(\d+)/;
const CATEGORY_RE = /https?:\/\/((?:brand|smartstore)\.naver\.com)\/([^/?#]+)\/category\/([^/?#]+)/;

const STATUS_LABELS: Record<string, string> = {
  SALE: "판매중",
  OUTOFSTOCK: "품절",
  SUSPENSION: "판매중지",
  CLOSE: "판매종료",
  PROHIBITION: "판매금지",
  WAIT: "판매대기",
  UNADMISSION: "승인대기",
  REJECTION: "승인거부",
  DELETE: "삭제됨",
};

export function label(status: string | null | undefined): string {
  return (status && STATUS_LABELS[status]) || status || "알 수 없음";
}

export function parseProductUrl(url: string): { slug: string; productId: string } {
  const m = PRODUCT_URL_RE.exec(url);
  if (!m) throw new Error(`지원하지 않는 URL 형식입니다: ${url}`);
  return { slug: m[1]!, productId: m[2]! };
}

export const isCategory = (url: string): boolean => CATEGORY_RE.test(url);

/**
 * 카테고리 주소를 '최신 등록순 + 한 페이지에 size 개' 로 다시 쓴다.
 * 브라우저에서 복사한 ?cp=1 형태는 서버 렌더링이 안 돼 __PRELOADED_STATE__ 가 없다.
 * st=RECENT 는 신상품 감시에 필수다.
 */
export function categoryFetchUrl(url: string, size: number): { fetchUrl: string; host: string; slug: string } {
  const m = CATEGORY_RE.exec(url);
  if (!m) throw new Error(`지원하지 않는 카테고리 URL 입니다: ${url}`);
  const host = m[1]!;
  const slug = m[2]!;
  const catId = m[3]!;
  return { fetchUrl: `https://${host}/${slug}/category/${catId}?st=RECENT&size=${size}`, host, slug };
}

export function imageUrl(info: Pick<ProductInfo, "image">, size = "f640"): string | null {
  const src = info.image;
  if (!src) return null;
  return src.includes("?") ? src : `${src}?type=${size}`;
}

export const priceText = (v: number | null): string =>
  typeof v === "number" ? `${v.toLocaleString("ko-KR")}원` : "-";
export const stockText = (v: number | null): string =>
  typeof v === "number" ? `${v.toLocaleString("ko-KR")}개` : "미공개";

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const isObj = (v: unknown): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 상품 상세 / 목록 어느 쪽에서 온 노드든 같은 모양으로 정규화한다. */
export function productInfo(node: Json, url: string): ProductInfo {
  const status: string | null = node.productStatusType ?? null;
  return {
    productId: String(node.id),
    name: node.dispName || node.name || "(이름 없음)",
    status,
    stock: num(node.stockQuantity),
    price: num(node.dispSalePrice || node.salePrice),
    image: node.representativeImageUrl ?? null,
    category: node.category?.categoryName ?? null,
    url,
    displayed: node.channelProductDisplayStatusType === "ON",
    inStock: status !== null && IN_STOCK_STATUSES.has(status),
    options: [],
    maxPerId: null,
    discounted: null,
  };
}

/**
 * 상품 노드를 찾는다. 네이버가 모양을 자주 바꾸므로 한 곳만 보지 않고 단계적으로 넓혀 간다.
 * (2026-08 초에도 simpleProductForDetailPage.A 에서 한 겹이 빠졌다.)
 */
export function findProductNode(data: Json, productId?: string): Json | null {
  const usable = (n: Json): boolean =>
    isObj(n) && !!n.id && !!n.productStatusType && (productId === undefined || String(n.id) === productId);

  const sp = data?.simpleProductForDetailPage ?? {};
  if (usable(sp)) return sp; // 현재 모양: 노드가 바로 들어있음
  if (isObj(sp)) for (const v of Object.values(sp)) if (usable(v)) return v; // 예전 모양: {"A": {...}}
  for (const key of ["product", "simpleProduct", "productDetail"]) {
    if (usable(data?.[key])) return data[key];
  }

  const stack: Json[] = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) stack.push(...cur);
    else if (isObj(cur)) {
      if (usable(cur)) return cur;
      stack.push(...Object.values(cur));
    }
  }
  return null;
}

const OPTION_NAME_KEYS = ["optionName1", "optionName2", "optionName3", "optionName", "name"] as const;

function rowsFrom(items: unknown): OptionRow[] {
  if (!Array.isArray(items)) return [];
  const out: OptionRow[] = [];
  for (const it of items) {
    if (!isObj(it) || !("stockQuantity" in it)) continue;
    const parts = OPTION_NAME_KEYS.map((k) => it[k])
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map(String);
    out.push({
      name: [...new Set(parts)].join(" / ") || `옵션 ${it.id ?? "?"}`,
      stock: num(it.stockQuantity),
      price: num(it.price) ?? 0,
      usable: it.usable ?? true,
    });
  }
  return out;
}

/**
 * 옵션별 재고. 조합형/표준형/단독형에 따라 키가 다르므로 알려진 위치를 먼저 보고,
 * 없으면 stockQuantity 를 가진 dict 리스트를 상태 전체에서 찾는다.
 * (실제 옵션 상품 샘플을 못 구해 방어적으로 짠 부분 — 이상하게 나오면 알려주세요.)
 */
export function optionRows(data: Json, node: Json): OptionRow[] {
  for (const holder of [node, data?.product ?? {}]) {
    for (const key of ["optionCombinations", "optionStandards", "productOptions", "options"]) {
      const rows = rowsFrom(holder?.[key]);
      if (rows.length) return rows;
    }
    const group = holder?.optionCombinationGroups;
    if (isObj(group)) {
      const rows = rowsFrom(group.optionCombinations);
      if (rows.length) return rows;
    }
  }

  const stack: Json[] = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      if (
        cur.length > 1 &&
        cur.every((x) => isObj(x) && "stockQuantity" in x && OPTION_NAME_KEYS.some((k) => k in x))
      ) {
        const rows = rowsFrom(cur);
        if (rows.length) return rows;
      }
      stack.push(...cur);
    } else if (isObj(cur)) {
      stack.push(...Object.values(cur));
    }
  }
  return [];
}

export function lookup(url: string, data: Json): ProductInfo {
  const { productId } = parseProductUrl(url);
  const node = findProductNode(data, productId);
  if (!node) throw new Error("상품 정보를 찾지 못했습니다 (삭제되었거나 비공개 상품).");

  const info = productInfo(node, url);
  info.options = optionRows(data, node);
  info.maxPerId = num(node.purchaseQuantityInfo?.maxPurchaseQuantityPerId);
  info.discounted = num(node.benefitsView?.discountedSalePrice);
  if (info.stock === null) info.stock = num(data?.product?.stockQuantity); // 상세에 없을 때 product 쪽을 한 번 더
  return info;
}

export function categoryItems(
  data: Json,
  host: string,
  slug: string,
): { items: ProductInfo[]; total: number | null } {
  const cp = data?.categoryProducts ?? {};
  const nodes: Json[] = cp.simpleProducts ?? [];
  if (!nodes.length) throw new Error("상품 목록이 비어 있습니다 (카테고리 주소 확인 필요).");
  const items = nodes.filter((n) => n?.id).map((n) => productInfo(n, `https://${host}/${slug}/products/${n.id}`));
  return { items, total: num(cp.totalCount) };
}
