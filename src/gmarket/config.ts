/**
 * G마켓 판 설정 — `../gmarket_config.json` 의 **"buy" 한 칸.**
 *
 * 파이썬 감시(gmarket_item_stock.py · gmarket_watch.py)와 같은 파일이다. 그쪽이 쓰는 칸
 * (products · discord_webhook_url · item_interval_seconds …)은 그대로 같이 읽고, 사는 데
 * 필요한 것만 "buy" 칸에 모았다 — 스마트스토어 판(smartstore_config.json 의 "buy")과 같은
 * 짜임이다. 파이썬 판은 이 칸을 모르고 지나간다.
 *
 * 상태·로그·세션은 파이썬 판과 갈라 쓴다. 같은 파일에 두 프로세스가 쓰면 서로 덮는다.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf, itemUrl } from "./parse.js";

// naver/ — src/gmarket 에서 돌든 dist/gmarket 에서 돌든 세 칸 위다.
export const ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const CONFIG_PATH = resolve(ROOT, "gmarket_config.json");
/**
 * 로그인 세션(쿠키). --login 이 만든다. 남과 공유하면 안 된다.
 * 꼴은 Playwright storageState 와 같다 — Playwright 판이 만든 파일을 그대로 읽는다 (launch.ts).
 */
export const SESSION_PATH = resolve(ROOT, "gmarket_session.json");
export const STATE_PATH = resolve(ROOT, "gmarket_buy_state.json");
export const LOG_PATH = resolve(ROOT, "gmarket-buy.log");
/** 결제하기 뒤 화면을 받아 적는 곳. 어긋났을 때와 --dump-pay 때 쓴다. */
export const PG_DUMP_PATH = resolve(ROOT, "gmarket-pg-dump.txt");

/**
 * 주문서에 도착한 뒤 어디까지 갈 것인가. 롯데온 판과 이름을 맞췄다.
 *
 *   "open"    주문서를 열어 두고 멈춘다
 *   "agree"   필수 동의까지 체크하고 멈춘다
 *   "submit"  (기본) 결제하기까지 누른다. pg_password 가 있으면 스마일페이 비밀번호 자판까지
 */
export const ACTIONS = ["open", "agree", "submit"] as const;
export type OrderAction = (typeof ACTIONS)[number];
export type Stage = "opened" | "agreed" | "submitted";

/** 살 상품 하나. 설정에는 주소 한 줄로 적어도 되고, 수량·옵션을 붙인 꼴로 적어도 된다. */
export interface BuyTarget {
  code: string;
  url: string;
  ea: number;
  /** 옵션 상품이면 무엇을 고를지. 화면에 보이는 글자의 일부면 된다. */
  option: string;
  maxPrice: number;
  label: string;
}

export interface BuyConfig {
  /** 살 상품. **비어 있으면 아무것도 사지 않는다** — 재입고 알림만 보낸다. */
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
  /**
   * Cloudflare 봇 확인이 떴을 때 사람이 창에서 마치기를 기다리는 시간(초). 감시·구매 공통.
   * 프로그램은 확인 화면에서 아무것도 누르지 않는다.
   */
  botCheckWaitSeconds: number;
  /**
   * 크롬을 창 없이 띄울까 (기본 true, Stealth). 사람이 봐야 하는 일 — 봇 확인·사기 — 이 생기면
   * 그때 창을 띄워 옮겨 간다 (1~2초). 드랍처럼 1초가 아까우면 false(또는 --show)로 처음부터 창을 둔다.
   * 로그인(--login)은 이 값과 상관없이 늘 창에서 한다.
   */
  headless: boolean;
  /** 드랍 모드(--drop)의 조회 간격·흔들림(초). */
  dropIntervalSeconds: number;
  dropJitterSeconds: number;
  /** 주문서에서 고를 결제수단. 한 줄이 한 단계. **비워 두면 건드리지 않는다.** */
  payMethod: string[];
  /** 결제수단을 고른 뒤 화면에 보여야 하는 글자 (`|` 로 여러 철자). 비워 두면 안 본다. */
  payMethodMark: string;
  /** 스마일페이 비밀번호. 비워 두면 자판 앞에서 멈춘다. 값은 로그·덤프에 남기지 않는다. */
  pgPassword: string;
  pgDump: boolean;
  paidWaitMinutes: number;
  paidMarkers: string[];
  /** 무엇을 디스코드로 보낼지: opened · blocked · session · paid */
  notify: string[];
  mention: string;
}

export interface Config {
  webhook: string;
  /** 재입고 알림에 붙일 멘션. 파이썬 판과 같은 칸(restock_mention → mention)을 읽는다. */
  restockMention: string;
  /** 감시할 상품번호. products 와 buy.targets 를 합친 것이다. */
  codes: string[];
  intervalSeconds: number;
  jitterSeconds: number;
  /** 같은 상품의 재입고 알림을 이 시간(분) 안에 또 보내지 않는다. */
  alertCooldownMinutes: number;
  errorNotifyAfter: number;
  buy: BuyConfig;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;

const int = (v: unknown, dflt: number): number => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Math.trunc(Number(v)) : dflt);
const flt = (v: unknown, dflt: number): number => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : dflt);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

function readRaw(path: string): Raw {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\u{FEFF}/u, "")) as Raw;
}

/**
 * 완료 화면에만 뜨는 글자. **주소가 먼저다.** 화면 글자는 주문서를 떠났을 때만 믿는다 —
 * 주문서의 단계 표시줄에도 "주문완료" 가 붙을 수 있어서다 (bnkr 판에서 실제로 그랬다).
 * G마켓 완료 화면은 아직 못 봤다. 받아 적은 것이 생기면 여기를 고친다.
 */
const PAID_MARKERS = ["주문이 완료", "주문완료", "결제가 완료", "결제완료", "/complete", "OrderComplete", "orderComplete"];

/** 살 상품 한 줄. 주소 문자열이든 {url, ea, option, max_price, label} 이든 받는다. */
export function parseTarget(entry: unknown): BuyTarget {
  const spec = (typeof entry === "string" || typeof entry === "number" ? { url: String(entry) } : entry ?? {}) as Raw;
  const code = codeOf(spec.url ?? spec.code);
  if (!code) throw new Error(`상품번호를 알아볼 수 없습니다: ${JSON.stringify(entry).slice(0, 80)}`);
  return {
    code,
    url: itemUrl(code),
    ea: Math.max(int(spec.ea, 1), 1),
    option: String(spec.option ?? "").trim(),
    maxPrice: int(spec.max_price, 0),
    label: String(spec.label ?? ""),
  };
}

function parseBuy(raw: Raw, mention: string): BuyConfig {
  const action = String(raw.order_action ?? "submit").toLowerCase() as OrderAction;
  const targets: BuyTarget[] = [];
  for (const one of Array.isArray(raw.targets) ? raw.targets : []) {
    const t = parseTarget(one);
    if (!targets.some((have) => have.code === t.code)) targets.push(t);
  }
  return {
    targets,
    // 모르는 값이 적혀 있으면 덜 가는 쪽(open)으로 물러선다.
    orderAction: ACTIONS.includes(action) ? action : "open",
    // 품절 → 구매가능 으로 **바뀌는 순간**에만 산다. 켤 때 이미 팔고 있던 것은 사지 않는다.
    buyOnRestockOnly: bool(raw.buy_on_restock_only, true),
    maxPrice: int(raw.max_price, 0),
    maxBuysPerRun: Math.max(int(raw.max_buys_per_run, 1), 1),
    stopAfterSuccess: bool(raw.stop_after_success, true),
    cooldownMinutes: int(raw.cooldown_minutes, 30),
    maxAttempts: Math.max(int(raw.max_attempts, 2), 1),
    retryDelaySeconds: flt(raw.retry_delay_seconds, 1),
    browserTimeoutSeconds: Math.max(int(raw.browser_timeout_seconds, 20), 5),
    botCheckWaitSeconds: Math.max(int(raw.bot_check_wait_seconds, 300), 10),
    headless: bool(raw.headless, true),
    dropIntervalSeconds: Math.max(flt(raw.drop_interval_seconds, 1), 0.5),
    dropJitterSeconds: Math.max(flt(raw.drop_jitter_seconds, 0.2), 0),
    payMethod: strList(raw.pay_method),
    payMethodMark: String(raw.pay_method_mark ?? "").trim(),
    // 파일에 두기 싫으면 환경변수로 넘긴다.
    pgPassword: String(process.env.GMARKET_PG_PASSWORD || raw.pg_password || "").replace(/\D/g, ""),
    pgDump: bool(raw.pg_dump, true),
    paidWaitMinutes: int(raw.paid_wait_minutes, 10),
    paidMarkers: Array.isArray(raw.paid_markers) ? strList(raw.paid_markers) : PAID_MARKERS,
    notify: Array.isArray(raw.notify) ? strList(raw.notify) : ["opened", "blocked", "session", "paid"],
    mention: String(raw.mention ?? mention),
  };
}

export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error(`설정 파일이 없습니다: ${path}`);
  const raw = readRaw(path);
  const restockMention = String(raw.restock_mention ?? raw.mention ?? "@everyone");
  const buy = parseBuy(raw.buy ?? {}, restockMention);

  // 살 상품은 감시 목록에도 넣는다. 두 군데 적게 하지 않는다.
  const codes: string[] = [];
  for (const entry of strList(raw.products)) {
    const code = codeOf(entry);
    if (code && !codes.includes(code)) codes.push(code);
  }
  for (const t of buy.targets) if (!codes.includes(t.code)) codes.push(t.code);

  return {
    webhook: String(process.env.DISCORD_GMARKET_WEBHOOK_URL || raw.discord_webhook_url || "").trim(),
    restockMention,
    codes,
    // 파이썬 판(gmarket_item_stock.py)의 칸을 그대로 읽는다. 같은 걸음으로 간다.
    intervalSeconds: Math.max(flt(raw.item_interval_seconds, 5), 1),
    jitterSeconds: Math.max(flt(raw.item_jitter_seconds, 1), 0),
    alertCooldownMinutes: int(raw.item_cooldown_minutes, 5),
    errorNotifyAfter: int(raw.error_notify_after, 3),
    buy,
  };
}

/**
 * 설정 파일의 "buy" 칸만 고쳐 쓴다.
 *
 * **읽은 값을 통째로 다시 쓰지 않는다.** 파이썬 판과 같은 파일이라, 이쪽이 모르는 칸도
 * 그대로 남아야 한다. 날 JSON 을 읽어 "buy" 칸만 바꾸고 나머지는 손대지 않는다.
 */
export function editBuy(edit: (buy: Raw) => void, path = CONFIG_PATH): void {
  const raw = existsSync(path) ? readRaw(path) : {};
  const buy = (raw.buy ??= {}) as Raw;
  edit(buy);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

/** 감시를 시작할 때 배너에 적는 줄. 켜 놓고 잊어버리는 설정이라 매번 눈에 띄어야 한다. */
export function arrivalLine(cfg: Config): string {
  const b = cfg.buy;
  const pay = b.payMethod.length ? `결제수단 ${b.payMethod.join(" → ")} → ` : "";
  if (b.orderAction === "submit") {
    return b.pgPassword
      ? `필수 동의 → ${pay}결제하기 → 스마일페이 비밀번호까지 누릅니다 — **사람 손 없이 결제됩니다** (pg_password)`
      : `필수 동의 → ${pay}결제하기까지 누르고 비밀번호 자판 앞에서 멈춥니다 — 비밀번호는 사람이 넣습니다`;
  }
  if (b.orderAction === "agree") return "주문서에서 필수 동의까지 하고 멈춥니다 — 결제는 사람이 누릅니다";
  return "주문서까지만 갑니다 — 결제는 사람이 누릅니다";
}
