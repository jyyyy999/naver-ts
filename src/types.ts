export interface OptionRow {
  name: string;
  stock: number | null;
  price: number;
  usable: boolean;
}

export interface ProductInfo {
  productId: string;
  name: string;
  status: string | null;
  stock: number | null;
  price: number | null;
  image: string | null;
  category: string | null;
  url: string;
  displayed: boolean;
  inStock: boolean;
  options: OptionRow[];
  maxPerId: number | null;
  discounted: number | null;
}

export interface Config {
  discordWebhookUrl: string;
  restockMention: string;
  newProductMention: string;
  checkIntervalSeconds: number;
  categoryIntervalSeconds: number;
  intervalJitterRatio: number;
  delayBetweenProductsSeconds: number;
  errorNotifyAfter: number;
  categoryPageSize: number;
  maxNewProductNotify: number;
  products: string[];
  categories: string[];
  buy: BuyConfig;
}

/**
 * 주문서에 도착한 뒤 어디까지 갈 것인가.
 *
 *   "open"    주문서를 열어 두고 멈춘다
 *   "submit"  (기본) 결제하기를 눌러 **인증 화면을 띄운다.** pg_password 가 있으면 자판까지 누른다
 *
 * 롯데온 판에 있던 "agree" 는 없다. 네이버페이 주문서는 필수 동의를 따로 누르지 않는다.
 */
export const ACTIONS = ["open", "submit"] as const;
export type OrderAction = (typeof ACTIONS)[number];
export type Stage = "opened" | "submitted";

/** 살 상품 하나. 설정에는 주소 한 줄로 적어도 되고, 수량·옵션을 붙인 꼴로 적어도 된다. */
export interface BuyTarget {
  productId: string;
  url: string;
  ea: number;
  /** 옵션 상품이면 무엇을 고를지. 화면에 보이는 글자의 일부면 된다. */
  option: string;
  maxPrice: number;
  label: string;
}

/**
 * 구매 설정. smartstore_config.json 의 "buy" 한 칸에 모아 둔다.
 *
 * 파이썬 판(smartstore_stock.py)과 같은 설정 파일을 쓰므로, 맨 위 칸에 흩어 놓지 않고
 * 한 칸에 묶었다 — 파이썬 판은 이 칸을 모르고 지나간다.
 */
export interface BuyConfig {
  /** 살 상품. **비어 있으면 아무것도 사지 않는다** — 지금까지처럼 알림만 보낸다. */
  targets: BuyTarget[];
  orderAction: OrderAction;
  buyOnRestockOnly: boolean;
  maxPrice: number;
  maxBuysPerRun: number;
  stopAfterSuccess: boolean;
  cooldownMinutes: number;
  maxAttempts: number;
  retryDelaySeconds: number;
  browserTimeoutSeconds: number;
  /** 네이버페이 간편결제 비밀번호. 비워 두면 인증 화면 앞에서 멈춘다. 값은 로그·덤프에 남기지 않는다. */
  pgPassword: string;
  /**
   * 비밀번호 뒤 마지막 확인 화면에서 차례로 누를 것. 기본 ["결제내용에 동의", "결제"].
   * 비우면 그 화면에서 멈춘다 (사람이 누른다).
   */
  finishSteps: string[];
  pgDump: boolean;
  paidWaitMinutes: number;
  paidMarkers: string[];
  /** 무엇을 디스코드로 보낼지: opened · blocked · session · paid */
  notify: string[];
  mention: string;
}

/** 상태 파일의 "_buy" 칸에 상품마다 적어 두는 것. */
export interface BuyEntry {
  name?: string;
  /** 살 수 있었나 — 품절→구매가능 으로 **바뀌는 순간**을 잡으려고 적어 둔다. */
  buyable?: boolean;
  done?: boolean;
  opened?: boolean;
  stage?: Stage;
  blocked?: string;
  opened_at?: string;
  last_try_at?: string;
  /** 사이트가 "품절" 이라며 막은 것이 몇 번 이어졌나 (watch.ts 의 LOST_RACE_LIMIT). */
  lost_races?: number;
}

// 상태 파일은 Python 버전과 같은 평평한 스키마를 쓴다:
//   { "<상품URL>": {status, stock, name, checked}, "_meta": {...}, "_categories": {"<카테고리URL>": {seen, total, checked}} }
export interface ProductState {
  status: string | null;
  stock: number | null;
  name: string;
  checked: string;
}

export interface CategoryState {
  seen: string[];
  total: number | null;
  checked: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type State = Record<string, any>;
