import type { Discord } from "./discord.js";
import type { Fetcher } from "./fetcher.js";
import { log } from "./log.js";
import { categoryFetchUrl, categoryItems } from "./parse.js";
import type { CategoryState, Config, ProductInfo, State } from "./types.js";

/** 카테고리의 최신 등록순 상품 목록을 가져온다. */
export async function fetchCategory(
  fetcher: Fetcher,
  url: string,
  size: number,
): Promise<{ items: ProductInfo[]; total: number | null }> {
  const { fetchUrl, host, slug } = categoryFetchUrl(url, size);
  return categoryItems(await fetcher.state(fetchUrl), host, slug);
}

/**
 * 카테고리를 훑어 처음 보는 상품이 있으면 알린다.
 *
 * 상품 ID 집합을 기준선으로 삼는다. saleType 'NEW' 같은 건 판매자가 직접 정하는 값이라 못 믿는다.
 * 처음 보는 ID 인지가 유일하게 확실한 신호다.
 */
export async function checkCategory(
  cfg: Config,
  fetcher: Fetcher,
  discord: Discord,
  state: State,
  catUrl: string,
): Promise<void> {
  // 페이지가 무거울수록 차단에 가까워진다. 신상품 감지에는 최신 수십 개면 충분하다.
  const { items, total } = await fetchCategory(fetcher, catUrl, cfg.categoryPageSize);

  const cats = (state._categories ??= {}) as Record<string, CategoryState>;
  const entry = (cats[catUrl] ??= { seen: [], total: null, checked: "" });
  const seen = new Set(entry.seen);

  if (!seen.size) {
    log.info(`카테고리 기준선 등록 — 상품 ${items.length}개 (전체 ${total ?? "?"}개) [${catUrl.slice(-40)}]`);
  } else {
    const fresh = items.filter((i) => !seen.has(i.productId));
    if (fresh.length) {
      log.info(`신상품 ${fresh.length}개 감지 (전체 ${total ?? "?"}개)`);
      const shown = fresh.slice(0, cfg.maxNewProductNotify);
      shown.forEach((i) => log.info(`  🆕 ${i.name} (${i.productId})`));
      await discord.newProducts(cfg, catUrl, shown, total);
      if (fresh.length > shown.length) log.info(`  ... 외 ${fresh.length - shown.length}개 (알림 생략)`);
    } else {
      log.info(`카테고리 신상품 없음 — 상품 ${items.length}개 (전체 ${total ?? "?"}개) [${catUrl.slice(-40)}]`);
    }
  }

  // 목록에서 빠진 상품도 기준선에서 뺀다. 안 그러면 seen 이 무한정 커지고,
  // 잠시 내려갔다 다시 올라온 상품을 신상품으로 못 잡는다.
  entry.seen = items.map((i) => i.productId);
  entry.total = total;
  entry.checked = new Date().toISOString();
}
