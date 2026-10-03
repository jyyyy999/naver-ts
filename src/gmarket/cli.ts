/**
 * G마켓 바로구매 — 지켜보다가 열리면 산다. (lotte-test · 스마트스토어 판과 같은 흐름)
 *
 *   지켜보기(브라우저 안 fetch) → 품절→구매가능 감지 → 창을 띄워 구매하기 → 주문서
 *   → 필수 동의 → [결제수단] → 결제하기 → [스마일페이 비밀번호] → 결제 완료 알림
 *
 * 설정은 ../gmarket_config.json 의 "buy" 칸. 파이썬 감시(gmarket_item_stock.py)와 같은 파일이다.
 * **ts 폴더에서 `.\gm` 으로 부른다** — 파워셸에서 `npm run gm -- --pin 1234` 는 `--` 가 지워진다.
 *
 * 크롬은 puppeteer-extra + Stealth 로 띄운다 (launch.ts). 기본은 창 없이, 사람이 봐야 하면 창으로.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { log, setLogFile } from "../log.js";
import { clipboardText, cmdAdd, cmdBuy, cmdPin, cmdStatus, targetFor, urlOf } from "./commands.js";
import { ACTIONS, CONFIG_PATH, loadConfig, LOG_PATH, PG_DUMP_PATH, SESSION_PATH, STATE_PATH, type OrderAction } from "./config.js";
import { Discord } from "./discord.js";
import { waitBuyers } from "./order.js";
import { codeOf } from "./parse.js";
import { doLogin, Watcher, whoami } from "./session.js";
import { loadState, saveState, watch } from "./watch.js";

const HELP = `G마켓 바로구매 — 사용법:  .\\gm [옵션] [주소 …]      (ts 폴더에서)

  (옵션 없이)       지켜보다가 열리면 산다. buy.targets 가 비어 있으면 재입고 알림만
  --login          창을 띄워 G마켓에 직접 로그인하고 세션을 저장 (../gmarket_session.json)
  --whoami         로그인 세션이 살아 있는지
  --status [주소…] 지금 재고·가격·구매 한도 (주소 없이 = 설정의 상품 전부)
  --once           한 바퀴만 보고 끝낸다
  --dry-run        사지 않고, 디스코드로 보내지 않고, 기록도 안 남기고 본다
  --drop           드랍 모드 — 1초 주기(±0.2), 재시도 쉼 없음 (buy.drop_interval_seconds)
  --no-buy         이번 실행은 사지 않고 알림만
  --show           크롬을 처음부터 창으로 띄운다 (기본은 창 없이 — buy.headless). 드랍이면 같이 주세요

  크롬은 Stealth 모드로 창 없이 돈다. 봇 확인이 뜨거나 사기 시작하면 그때 창을 띄워 옮겨 갑니다 (1~2초).
  봇 확인은 그 창에서 직접 마쳐 주세요 — 프로그램은 확인 화면을 누르지 않고 기다립니다
  (buy.bot_check_wait_seconds, 기본 300초).

  --add 주소 …     살 상품을 buy.targets 에 넣는다
  --link [주소]    클립보드(또는 준) 상품 하나만 이번 실행의 대상으로 삼고 곧장 감시
  --buy [주소]     지금 바로 산다, order_action 이 정한 데까지 (주소 없이 = buy.targets 의 첫 상품)
  --dump-pay [주소] --buy 와 같되, 결제하기 뒤 화면을 gmarket-pg-dump.txt 에 받아 적는다
  --action open|agree|submit   이번만 어디까지 갈지 (기본은 설정의 buy.order_action)
  --reset          산 기록을 지운다
  --pin [비밀번호]  스마일페이 비밀번호 저장 (값 없이 = 클립보드, clear = 지우기).
                   저장하면 submit 에서 **결제까지 끝난다.** 파일이 싫으면 GMARKET_PG_PASSWORD 환경변수
  --test           웹훅 테스트 메시지
`;

const OPTIONS = {
  login: { type: "boolean", default: false },
  whoami: { type: "boolean", default: false },
  status: { type: "boolean", default: false },
  once: { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
  drop: { type: "boolean", default: false },
  "no-buy": { type: "boolean", default: false },
  show: { type: "boolean", default: false },
  add: { type: "boolean", default: false },
  link: { type: "boolean", default: false },
  buy: { type: "boolean", default: false },
  "dump-pay": { type: "boolean", default: false },
  action: { type: "string" },
  reset: { type: "boolean", default: false },
  pin: { type: "boolean", default: false },
  test: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

/**
 * npm 이 가져간 옵션을 되찾는다. (스마트스토어 판 cli.ts 와 같다)
 * 윈도우 파워셸(5.1)은 `npm run gm -- --pin 1234` 의 `--` 를 지워서 npm 이 `--pin` 을 제 설정으로
 * 가져간다. 가져간 것은 환경변수(npm_config_pin=true)에 남으니 거기서 되찾는다.
 */
function recoverNpmFlags(args: string[]): string[] {
  if (!process.env.npm_lifecycle_event) return args;
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
    const at = rest.findIndex((a) => (ACTIONS as readonly string[]).includes(a.toLowerCase()));
    if (at < 0) throw new Error(`파워셸이 '--' 를 지워서 npm 이 --${name} 을 가져갔습니다.\n  npm 을 거치지 않는 gm 으로 불러 주세요:  .\\gm --${name} 값`);
    back.push("--action", rest.splice(at, 1)[0]!);
  }
  if (!given.has("no-buy") && env("buy") === "") back.push("--no-buy");
  if (back.length) log.debug(`npm 이 가져간 옵션을 되찾았습니다: ${back.join(" ")}`);
  return [...back, ...rest];
}

// 로그인 여부를 물어볼 상품. 어느 상품 페이지든 IsLogin 을 그려 준다.
const FALLBACK_PROBE = "4844939494";

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ args: recoverNpmFlags(process.argv.slice(2)), allowPositionals: true, options: OPTIONS });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const dryRun = values["dry-run"];
  if (!dryRun && !values.status) setLogFile(LOG_PATH);

  const probeCode = (): string => {
    try {
      return loadConfig().codes[0] ?? FALLBACK_PROBE;
    } catch {
      return FALLBACK_PROBE;
    }
  };
  if (values.login) return (await doLogin(SESSION_PATH, probeCode())) ? 0 : 1;
  if (values.whoami) {
    const [wait, headless] = (() => {
      try {
        const b = loadConfig().buy;
        return [b.botCheckWaitSeconds, b.headless && !values.show];
      } catch {
        return [300, !values.show];
      }
    })();
    return whoami(SESSION_PATH, probeCode(), wait, headless);
  }

  // 설정 파일만 고치고 끝나는 명령들.
  if (values.pin) return cmdPin(positionals[0] ?? "");
  if (values.add) {
    if (!positionals.length) throw new Error("--add 뒤에 상품 주소를 주세요.");
    return cmdAdd(positionals);
  }
  if (values.reset) {
    const state = loadState(STATE_PATH);
    delete state.buy;
    saveState(STATE_PATH, state, false);
    log.info("산 기록을 지웠습니다.");
    return 0;
  }

  const cfg = loadConfig();
  const action = values.action?.toLowerCase() as OrderAction | undefined;
  if (action !== undefined) {
    if (!ACTIONS.includes(action)) throw new Error(`--action 은 ${ACTIONS.join(" / ")} 중 하나입니다: ${values.action}`);
    cfg.buy.orderAction = action;
  }
  if (values.show) cfg.buy.headless = false;

  if (values.test) return (await new Discord(cfg.webhook, false).test(cfg)) ? 0 : 1;
  if (values.status) {
    const codes = positionals.length ? positionals.map((p) => codeOf(p)).filter((c): c is string => !!c) : cfg.codes;
    if (!codes.length) throw new Error(`${basename(CONFIG_PATH)} 의 products 가 비어 있습니다.`);
    return cmdStatus(cfg, codes);
  }

  if (values.buy || values["dump-pay"]) {
    if (!existsSync(SESSION_PATH)) throw new Error("로그인 세션이 없습니다 — 먼저  .\\gm --login");
    const url = positionals[0] ? urlOf(positionals[0]) : cfg.buy.targets[0]?.url;
    if (!url) throw new Error("살 상품 주소를 주세요 (또는 --add 로 buy.targets 에 넣어주세요).");
    // 사는 탭은 창에 연다. 창 없이 읽고 나서 창으로 다시 띄우는 1~2초를 아끼려고 처음부터 창이다.
    const watcher = new Watcher(SESSION_PATH, { headless: false });
    try {
      const code = await cmdBuy(cfg, new Discord(cfg.webhook, false), watcher, { state: STATE_PATH, dump: PG_DUMP_PATH }, url, values["dump-pay"]);
      // 사는 탭이 이 창에 있다. 사람이 탭을 닫을 때까지 창을 살려 둔다.
      await waitBuyers();
      return code;
    } finally {
      await watcher.close();
    }
  }

  if (values.link) {
    // 대상만 바꾸고 멈추지 않는다. 아래 감시로 그대로 흘러간다 — "복사해 두고 명령 한 번" 이 전부다.
    // 설정 파일은 건드리지 않는다.
    const target = targetFor(cfg, urlOf(positionals[0] ?? clipboardText()));
    cfg.codes = [target.code];
    cfg.buy.targets = [target];
    log.info(`✅ 이번 실행은 이 상품만 봅니다: ${target.url}`);
  } else if (positionals.length) {
    throw new Error(`모르는 인자입니다: ${positionals.join(" ")}  (주소는 --link · --buy · --add · --status 뒤에 줍니다)`);
  }

  if (!cfg.codes.length) throw new Error(`${basename(CONFIG_PATH)} 에 products 도 buy.targets 도 없습니다.`);
  const buying = !values["no-buy"] && cfg.buy.targets.length > 0;
  if (buying && !dryRun && !existsSync(SESSION_PATH)) {
    throw new Error("살 상품이 있는데 로그인 세션이 없습니다 — 먼저  .\\gm --login  (알림만 받으려면 --no-buy)");
  }
  if (!cfg.webhook && !dryRun) log.warn(`${basename(CONFIG_PATH)} 에 discord_webhook_url 이 없습니다 — 알림 없이 돕니다.`);

  const ac = new AbortController();
  process.on("SIGINT", () => {
    if (ac.signal.aborted) process.exit(130); // 두 번째 Ctrl+C 는 즉시 종료
    log.info("종료 신호를 받았습니다. 정리 중...");
    ac.abort();
  });

  const watcher = new Watcher(SESSION_PATH, { headless: cfg.buy.headless });
  try {
    await watcher.launch(); // 브라우저 문제는 감시를 시작하기 전에 드러낸다
    const code = await watch(cfg, watcher, new Discord(cfg.webhook, dryRun), {
      statePath: STATE_PATH,
      dryRun,
      once: values.once,
      drop: values.drop,
      signal: ac.signal,
      buy: buying ? { watcher, sessionPath: SESSION_PATH, dumpPath: PG_DUMP_PATH, dryRun } : null,
    });
    // 결제하던 탭이 있으면 사람이 닫을 때까지 기다린다. 창을 닫으면 그 탭도 같이 닫힌다.
    await waitBuyers();
    return code;
  } finally {
    await watcher.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
