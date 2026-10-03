import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { isCategory, parseProductUrl } from "./parse.js";
import { ACTIONS, type BuyConfig, type BuyTarget, type Config, type OrderAction } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

const int = (v: unknown, dflt: number): number => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Math.trunc(Number(v)) : dflt);
const flt = (v: unknown, dflt: number): number => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : dflt);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);

function readRaw(path: string): Raw {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\u{FEFF}/u, "")) as Raw;
}

/** Python 버전과 같은 smartstore_config.json (snake_case) 을 그대로 읽는다. */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) throw new Error(`설정 파일이 없습니다: ${path}`);
  return parseConfig(readRaw(path));
}

export const defaultConfig = (): Config => parseConfig({});

// 완료 화면에만 뜨는 글자. 주소가 먼저고, 화면 글자는 주문서를 떠났을 때만 믿는다 (order.ts).
const PAID_MARKERS = ["주문이 완료", "주문완료", "결제가 완료", "결제 완료", "orderComplete", "/order/complete"];

function parseConfig(raw: Raw): Config {
  return {
    discordWebhookUrl: (process.env.DISCORD_SMARTSTORE_WEBHOOK_URL || raw.discord_webhook_url || "").trim(),
    restockMention: raw.restock_mention ?? "",
    newProductMention: raw.new_product_mention ?? "",
    checkIntervalSeconds: Math.max(int(raw.check_interval_seconds, 30), 1),
    categoryIntervalSeconds: int(raw.category_interval_seconds, 300),
    intervalJitterRatio: flt(raw.interval_jitter_ratio, 0.2),
    delayBetweenProductsSeconds: flt(raw.delay_between_products_seconds, 2),
    errorNotifyAfter: int(raw.error_notify_after, 3),
    categoryPageSize: int(raw.category_page_size, 40),
    maxNewProductNotify: int(raw.max_new_product_notify, 20),
    products: strList(raw.products),
    categories: strList(raw.categories),
    buy: parseBuy(raw.buy ?? {}, raw.restock_mention ?? ""),
  };
}

/** "buy" 칸을 읽는다. 없으면 아무것도 안 사는 설정이 된다. */
function parseBuy(raw: Raw, mention: string): BuyConfig {
  const action = String(raw.order_action ?? "submit").toLowerCase() as OrderAction;
  return {
    targets: (Array.isArray(raw.targets) ? raw.targets : []).map(parseTarget),
    // 모르는 값이 적혀 있으면 덜 가는 쪽(open)으로 물러선다.
    orderAction: ACTIONS.includes(action) ? action : "open",
    // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다. 켤 때 이미 팔고 있던 것은 사지 않는다.
    buyOnRestockOnly: bool(raw.buy_on_restock_only, true),
    maxPrice: int(raw.max_price, 0),
    maxBuysPerRun: Math.max(int(raw.max_buys_per_run, 1), 1),
    stopAfterSuccess: bool(raw.stop_after_success, true),
    cooldownMinutes: int(raw.cooldown_minutes, 30),
    maxAttempts: Math.max(int(raw.max_attempts, 2), 1),
    retryDelaySeconds: flt(raw.retry_delay_seconds, 2),
    browserTimeoutSeconds: Math.max(int(raw.browser_timeout_seconds, 20), 5),
    // 파일에 두기 싫으면 환경변수로 넘긴다.
    pgPassword: String(process.env.NAVER_PG_PASSWORD || raw.pg_password || "").replace(/\D/g, ""),
    // 비밀번호 뒤 마지막 확인 (extension 의 "네이버페이 마지막 확인" 흐름, bnkr-test NPAY_FINISH).
    finishSteps: Array.isArray(raw.finish_steps) ? strList(raw.finish_steps) : ["결제내용에 동의", "결제"],
    pgDump: bool(raw.pg_dump, true),
    paidWaitMinutes: int(raw.paid_wait_minutes, 10),
    paidMarkers: Array.isArray(raw.paid_markers) ? strList(raw.paid_markers) : PAID_MARKERS,
    notify: Array.isArray(raw.notify) ? strList(raw.notify) : ["opened", "blocked", "session", "paid"],
    mention: String(raw.mention ?? mention),
  };
}

/** 살 상품 한 줄. 주소 문자열이든 {url, ea, option, max_price, label} 이든 받는다. */
export function parseTarget(entry: unknown): BuyTarget {
  const spec = (typeof entry === "string" ? { url: entry } : entry ?? {}) as Raw;
  const { slug, productId } = parseProductUrl(String(spec.url ?? ""));
  const host = /brand\.naver\.com/.test(String(spec.url)) ? "brand.naver.com" : "smartstore.naver.com";
  return {
    productId,
    url: `https://${host}/${slug}/products/${productId}`,
    ea: Math.max(int(spec.ea, 1), 1),
    option: String(spec.option ?? "").trim(),
    maxPrice: int(spec.max_price, 0),
    label: String(spec.label ?? ""),
  };
}

/** 조회를 시작하기 전에 형식부터 검증해서 실패시킨다. */
export function validate(cfg: Config, configName: string, opts: { needWebhook: boolean }): void {
  if (!cfg.products.length && !cfg.categories.length) {
    throw new Error(`${basename(configName)} 의 products / categories 가 모두 비어 있습니다.`);
  }
  if (opts.needWebhook && !cfg.discordWebhookUrl) {
    throw new Error(`${basename(configName)} 의 discord_webhook_url 을 채워주세요.`);
  }
  cfg.products.forEach((u) => parseProductUrl(u));
  for (const u of cfg.categories) {
    if (!isCategory(u)) throw new Error(`지원하지 않는 카테고리 URL 입니다: ${u}`);
  }
}

/**
 * 살 상품은 감시 목록에도 넣는다. 두 군데 적게 하지 않는다.
 * 같은 상품인지는 주소가 아니라 상품번호로 본다 — 복사한 주소에는 꼬리(?nl-au=…)가 붙는다.
 */
export function watchBuyTargets(cfg: Config): void {
  const have = new Set(cfg.products.map((u) => parseProductUrl(u).productId));
  for (const t of cfg.buy.targets) {
    if (!have.has(t.productId)) {
      cfg.products.push(t.url);
      have.add(t.productId);
    }
  }
}

/**
 * 설정 파일의 "buy" 칸만 고쳐 쓴다.
 *
 * **읽은 값을 통째로 다시 쓰지 않는다.** 파이썬 판과 같은 파일이라, 이쪽이 모르는 칸도
 * 그대로 남아야 한다. 날 JSON 을 읽어 "buy" 칸만 바꾸고 나머지는 손대지 않는다.
 */
export function editBuy(path: string, edit: (buy: Raw) => void): void {
  const raw = existsSync(path) ? readRaw(path) : {};
  const buy = (raw.buy ??= {}) as Raw;
  edit(buy);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
}
