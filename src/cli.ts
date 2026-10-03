import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fetchCategory } from "./category.js";
import { clipboardText, cmdAdd, cmdBuy, cmdPin, cmdWhoami, targetFor, urlFrom } from "./commands.js";
import { defaultConfig, loadConfig, validate, watchBuyTargets } from "./config.js";
import { Discord } from "./discord.js";
import { BrowserError, Fetcher, LoginRequired, doLogin } from "./fetcher.js";
import { log, setLogFile, sleep } from "./log.js";
import { waitBuyers } from "./order.js";
import { isCategory, label, lookup, priceText, stockText } from "./parse.js";
import { ACTIONS, type Config, type OrderAction, type ProductInfo } from "./types.js";
import { loadState, RATE_HARD_PER_MIN, RATE_WARN_PER_MIN, rateOf, saveState, watch } from "./watch.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const SESSION_PATH = resolve(ROOT, "naver_session.json"); // Python 버전과 같은 파일 (Playwright storageState)
const DEFAULT_CONFIG = resolve(ROOT, "smartstore_config.json");
// 상태·로그는 Python 버전과 분리한다. 같은 파일에 두 프로세스가 쓰면 서로 덮어쓴다.
const DEFAULT_STATE = resolve(ROOT, "smartstore_state.ts.json");
const LOG_PATH = resolve(ROOT, "smartstore-ts.log");
// 결제하기 뒤 화면을 받아 적는 곳. 어긋났을 때와 --dump-pay 때 쓴다.
const PG_DUMP_PATH = resolve(ROOT, "smartstore-ts-pg-dump.txt");

const HELP = `사용법: .\\ss [옵션] [상품/카테고리 URL ...]      (ts 폴더에서)

  (URL 생략 시 smartstore_config.json 의 목록)
  npm start -- [옵션] 도 되지만, 파워셸은 '--' 를 지워 npm 이 옵션을 가져간다.
  대부분 되찾지만 값을 받는 옵션(--interval 5 · --state 경로 …)과 --help 는 .\\ss 로 불러야 한다.

  --login          브라우저를 띄워 네이버에 직접 로그인하고 세션을 저장
  --watch          계속 감시하며 디스코드로 알림 (buy.targets 가 있으면 열리는 순간 산다)
  --once           감시 1회차만 돌고 종료
  --interval 초    상품 감시 간격 (설정 파일보다 우선)
  --rate           요청률 표만 계산해서 보여주고 종료
  --test           웹훅 테스트 메시지 발송
  --dry-run        디스코드로 보내지 않고 보낼 내용만 로그로 (상태 파일도 안 씀, 사지도 않음)
  --json           조회 결과를 JSON 으로 출력
  --size N         조회 모드에서 카테고리를 읽을 상품 수
  --delay 초       조회 모드에서 URL 사이 대기 (기본 2)
  --config 경로    설정 파일 (기본 ../smartstore_config.json)
  --state 경로     상태 파일 (기본 ../smartstore_state.ts.json)
  --headful        브라우저 창을 보이게 (디버그용)

  구매 (lotte-test 와 같은 흐름 — 설정은 smartstore_config.json 의 "buy" 칸)
  --whoami         로그인 세션이 살아 있는지
  --add URL …      살 상품을 buy.targets 에 넣는다
  --link [URL]     클립보드(또는 준) 상품 주소 하나만 이번 실행의 감시·구매 대상으로 삼고 곧장 감시
  --buy [URL]      지금 바로 산다, order_action 이 정한 데까지 (주소 없이 부르면 buy.targets 의 첫 상품)
  --dump-pay [URL] --buy 와 같되, 결제하기 뒤 화면을 smartstore-ts-pg-dump.txt 에 받아 적는다
  --action open|submit   이번만 어디까지 갈지 (기본은 설정의 buy.order_action)
  --no-buy         이번 실행은 사지 않고 알림만
  --reset          산 기록을 지운다
  --pin [비밀번호]  간편결제 비밀번호 저장 (값 없이 = 클립보드, clear = 지우기).
                   저장하면 submit 에서 **결제까지 끝난다.** 파일이 싫으면 NAVER_PG_PASSWORD 환경변수
`;

function printInfo(info: ProductInfo): void {
  console.log(`\n${info.inStock ? "🟢" : "🔴"} ${info.name}`);
  console.log(`   ${info.url}`);
  console.log(`   상태   ${label(info.status)}${info.displayed ? "" : "  (숨김 상태)"}`);
  let price = `   가격   ${priceText(info.price)}`;
  if (typeof info.discounted === "number" && info.discounted !== info.price) price += `  →  할인가 ${priceText(info.discounted)}`;
  console.log(price);
  console.log(`   재고   ${stockText(info.stock)}`);
  if (info.maxPerId) console.log(`   구매   1인 최대 ${info.maxPerId}개`);
  if (info.options.length) {
    console.log(`   옵션   ${info.options.length}개`);
    for (const o of info.options) {
      const state = o.stock === 0 ? "품절" : stockText(o.stock);
      console.log(`          · ${o.name.padEnd(28)} ${state}${o.price ? `  (+${o.price.toLocaleString("ko-KR")}원)` : ""}${o.usable ? "" : "  [사용안함]"}`);
    }
  }
  console.log(`   조회   ${new Date().toLocaleString("sv-SE")}`);
}

function printCategory(url: string, items: ProductInfo[], total: number | null): void {
  console.log(`\n📂 ${url}`);
  console.log(`   상품 ${items.length}개 (전체 ${total ?? "?"}개, 최신 등록순)`);
  for (const i of items) {
    console.log(`   ${i.inStock ? "🟢" : "🔴"} ${i.productId.padStart(12)}  ${priceText(i.price).padStart(10)}  ${stockText(i.stock).padStart(7)}  ${i.name.slice(0, 44)}`);
  }
}

function showRate(cfg: Config): void {
  const n = cfg.products.length;
  const ncat = cfg.categories.length;
  const catMin = ncat ? (ncat * 60) / Math.max(cfg.categoryIntervalSeconds || cfg.checkIntervalSeconds, 1) : 0;

  console.log(`\n상품 ${n}개 + 카테고리 ${ncat}개(${cfg.categoryIntervalSeconds}초 간격, ${catMin.toFixed(1)}회/분) 기준 요청률\n`);
  console.log(`  ${"상품간격".padStart(8)}  ${"분당".padStart(8)}  ${"하루".padStart(10)}   판정`);
  for (const interval of [5, 10, 15, 20, 25, 30, 45, 60, 120, 300]) {
    const { perMin, perDay } = rateOf(n, interval, ncat, cfg.categoryIntervalSeconds);
    const verdict = perMin > RATE_HARD_PER_MIN ? "위험 — 거부됨" : perMin > RATE_WARN_PER_MIN ? "높음 — 경고" : "안전";
    const cur = interval === cfg.checkIntervalSeconds ? " ←현재" : "";
    console.log(`  ${String(interval).padStart(6)}초  ${perMin.toFixed(1).padStart(6)}회  ${Math.round(perDay).toLocaleString("ko-KR").padStart(9)}회   ${verdict}${cur}`);
  }
  console.log(`\n  권장선 ${RATE_WARN_PER_MIN}회/분, 거부선 ${RATE_HARD_PER_MIN}회/분`);
  if (n) {
    const safe = (n * 60) / Math.max(RATE_WARN_PER_MIN - catMin, 0.1);
    console.log(`  상품 ${n}개 + 카테고리 ${ncat}개면 권장선을 지키려면 상품 간격 ${Math.ceil(safe)}초 이상`);
  }
}

async function runLookup(cfg: Config, targets: string[], opts: { json: boolean; delay: number; headful: boolean }): Promise<number> {
  const fetcher = new Fetcher(SESSION_PATH, opts.headful);
  const results: unknown[] = [];
  let failed = 0;
  try {
    for (const [i, url] of targets.entries()) {
      try {
        if (isCategory(url)) {
          const { items, total } = await fetchCategory(fetcher, url, cfg.categoryPageSize);
          results.push({ category: url, total, products: items });
          if (!opts.json) printCategory(url, items, total);
        } else {
          const info = lookup(url, await fetcher.state(url));
          results.push(info);
          if (!opts.json) printInfo(info);
        }
      } catch (e) {
        if (e instanceof LoginRequired || e instanceof BrowserError) throw e;
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ url, error: msg });
        if (!opts.json) console.error(`\n⚠  조회 실패 — ${url}\n   ${msg}`);
      }
      if (i < targets.length - 1) await sleep(opts.delay * 1000);
    }
  } finally {
    await fetcher.close();
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  return failed ? 1 : 0;
}

const OPTIONS = {
  login: { type: "boolean", default: false },
  watch: { type: "boolean", default: false },
  once: { type: "boolean", default: false },
  interval: { type: "string" },
  test: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  rate: { type: "boolean", default: false },
  json: { type: "boolean", default: false },
  size: { type: "string" },
  delay: { type: "string", default: "2" },
  config: { type: "string" },
  state: { type: "string" },
  headful: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  // 구매
  whoami: { type: "boolean", default: false },
  add: { type: "boolean", default: false },
  link: { type: "boolean", default: false },
  buy: { type: "boolean", default: false },
  "dump-pay": { type: "boolean", default: false },
  action: { type: "string" },
  "no-buy": { type: "boolean", default: false },
  reset: { type: "boolean", default: false },
  pin: { type: "boolean", default: false },
} as const;

/**
 * npm 이 가져간 옵션을 되찾는다.
 *
 * 윈도우 파워셸(5.1)은 `npm start -- --pin 123456` 의 `--` 를 **지운다.** 그러면 npm 이
 * `--pin` 을 제 설정으로 가져가고(npm_config_pin=true) 우리에게는 `123456` 만 온다 —
 * "지원하지 않는 URL 형식입니다" 가 거기서 났다. 가져간 것은 환경변수에 남으니 거기서 되찾는다.
 *
 * 값을 받는 옵션은 값이 옵션에서 떨어져 뒤의 인자와 섞인다. --action 은 값이 open/submit
 * 뿐이라 골라낼 수 있지만, 숫자·경로를 받는 것은 어느 것이 누구 값인지 모른다 — 짐작하지
 * 않고 ss.cmd 로 부르라고 말한다. --help 는 npm 이 제 도움말을 띄우고 끝내서 여기까지 안 온다.
 */
function recoverNpmFlags(args: string[]): string[] {
  if (!process.env.npm_lifecycle_event) return args; // npm 으로 부른 게 아니다
  const env = (name: string): string | undefined => process.env[`npm_config_${name.replace(/-/g, "_")}`];
  const given = new Set(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));
  const rest = [...args];
  const back: string[] = [];

  for (const [name, spec] of Object.entries(OPTIONS)) {
    if (given.has(name) || env(name) !== "true") continue;
    if (spec.type === "boolean") {
      back.push(`--${name}`);
      continue;
    }
    const at = name === "action" ? rest.findIndex((a) => (ACTIONS as readonly string[]).includes(a.toLowerCase())) : -1;
    if (at < 0) {
      throw new Error(
        `파워셸이 '--' 를 지워서 npm 이 --${name} 을 가져갔습니다 (값 ${JSON.stringify(rest.join(" "))} 만 남음).\n` +
        `  npm 을 거치지 않는 ss 로 불러 주세요:  .\\ss --${name} 값 …`,
      );
    }
    back.push("--action", rest.splice(at, 1)[0]!);
  }
  // --no-buy 는 npm 이 buy=false 로 읽어 빈 값으로 남긴다.
  if (!given.has("no-buy") && env("buy") === "") back.push("--no-buy");

  if (back.length) log.debug(`npm 이 가져간 옵션을 되찾았습니다: ${back.join(" ")}`);
  return [...back, ...rest];
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: recoverNpmFlags(process.argv.slice(2)),
    allowPositionals: true,
    options: OPTIONS,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.login) return (await doLogin(SESSION_PATH)) ? 0 : 1;
  if (values.whoami) return cmdWhoami(SESSION_PATH);

  const configPath = values.config ? resolve(values.config) : DEFAULT_CONFIG;
  const statePath = values.state ? resolve(values.state) : DEFAULT_STATE;

  // 설정 파일만 고치고 끝나는 명령들. 주소·값은 뒤에 붙인 인자로 받는다.
  if (values.pin) return cmdPin(configPath, positionals[0] ?? "");
  if (values.add) {
    if (!positionals.length) throw new Error("--add 뒤에 상품 주소를 주세요.");
    return cmdAdd(configPath, positionals);
  }
  if (values.reset) {
    const state = loadState(statePath);
    delete state._buy;
    saveState(statePath, state, false);
    log.info("산 기록을 지웠습니다.");
    return 0;
  }

  // 이번만 어디까지 갈지. 설정을 고치지 않고 한 번 시험해 볼 자리다.
  const action = values.action?.toLowerCase() as OrderAction | undefined;
  if (action !== undefined && !ACTIONS.includes(action)) {
    throw new Error(`--action 은 ${ACTIONS.join(" / ")} 중 하나입니다: ${values.action}`);
  }

  const dryRun = values["dry-run"];

  if (values.buy || values["dump-pay"]) {
    setLogFile(LOG_PATH);
    const cfg = loadConfig(configPath);
    if (action) cfg.buy.orderAction = action;
    const url = positionals[0] ? urlFrom(positionals[0]) : (cfg.buy.targets[0]?.url ?? cfg.products[0]);
    if (!url) throw new Error("살 상품 주소를 주세요 (또는 --add 로 buy.targets 에 넣어주세요).");
    const discord = new Discord(cfg.discordWebhookUrl, false);
    const code = await cmdBuy(cfg, discord, { session: SESSION_PATH, state: statePath, dump: PG_DUMP_PATH }, url, values["dump-pay"]);
    await waitBuyers();
    return code;
  }

  const watching = values.watch || values.once || values.link;
  setLogFile(watching && !dryRun ? LOG_PATH : null);
  const needWebhook = (watching || values.test) && !dryRun;

  let cfg: Config;
  if (values.link) {
    // 대상만 바꾸고 멈추지 않는다. 아래 감시로 그대로 흘러간다 — "복사해 두고 명령 한 번" 이 전부다.
    // 설정 파일은 건드리지 않는다.
    cfg = loadConfig(configPath);
    const url = urlFrom(positionals[0] ?? clipboardText());
    const target = targetFor(cfg, url);
    cfg.products = [target.url];
    cfg.categories = [];
    cfg.buy.targets = [target];
    log.info(`✅ 이번 실행은 이 상품만 봅니다: ${target.url}`);
  } else if (positionals.length) {
    // 인자로 준 주소는 상품/카테고리를 알아서 갈라 담는다
    const given = { products: positionals.filter((u) => !isCategory(u)), categories: positionals.filter(isCategory) };
    const base = (watching || values.test) && existsSync(configPath) ? loadConfig(configPath) : defaultConfig();
    cfg = { ...base, ...given };
  } else {
    cfg = loadConfig(configPath);
    // 살 상품은 감시 목록에도 넣는다. 인자로 준 주소만 볼 때는 그 목록을 흐리지 않는다.
    watchBuyTargets(cfg);
  }
  if (action) cfg.buy.orderAction = action;
  if (values.interval) cfg.checkIntervalSeconds = Math.max(Math.trunc(Number(values.interval)) || 1, 1);
  if (values.size) cfg.categoryPageSize = Math.max(Math.trunc(Number(values.size)) || cfg.categoryPageSize, 1);
  validate(cfg, configPath, { needWebhook });

  if (values.rate) {
    showRate(cfg);
    return 0;
  }

  const discord = new Discord(cfg.discordWebhookUrl, dryRun);
  if (values.test) return (await discord.test(cfg)) ? 0 : 1;

  if (watching) {
    const ac = new AbortController();
    process.on("SIGINT", () => {
      if (ac.signal.aborted) process.exit(130); // 두 번째 Ctrl+C 는 즉시 종료
      log.info("종료 신호를 받았습니다. 정리 중...");
      ac.abort();
    });
    const fetcher = new Fetcher(SESSION_PATH, values.headful);
    const buying = !values["no-buy"] && cfg.buy.targets.length > 0;
    let code: number;
    try {
      await fetcher.launch(); // 세션·브라우저 문제는 첫 알림을 보내기 전에 드러낸다
      code = await watch(cfg, fetcher, discord, {
        statePath,
        dryRun,
        once: values.once,
        signal: ac.signal,
        buy: buying ? { sessionPath: SESSION_PATH, dumpPath: PG_DUMP_PATH, dryRun } : null,
      });
    } finally {
      await fetcher.close();
    }
    // 결제하던 창이 있으면 사람이 닫을 때까지 기다린다. 여기서 끝내면 창도 같이 닫힌다.
    await waitBuyers();
    return code;
  }

  return runLookup(cfg, [...cfg.products, ...cfg.categories], {
    json: values.json,
    delay: Number(values.delay) || 2,
    headful: values.headful,
  });
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
