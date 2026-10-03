/**
 * 주문서까지 데려다 놓고, 시킨 데까지 마저 누르는 일. (스마트스토어 판 ../order.ts 와 같은 짜임)
 *
 *   구매하기 → 주문서 → [필수 동의] → [결제수단] → [결제하기] → [스마일페이 비밀번호] → 결제 완료 알림
 *
 * 어디까지 갈지는 buy.order_action 이 정한다 (open · agree · submit). pg_password 를 적어
 * 두면 비밀번호 자판까지 눌러 준다 — **그 순간 결제가 끝난다.** 사람 손을 안 거치는
 * 자리라 배너와 로그에 크게 적는다.
 *
 * 사는 탭은 감시하는 크롬의 창에 연다 (session.ts). 탭은 어떻게 끝나든 닫지 않는다. 어디서
 * 멈췄는지 사람이 봐야 하고, 결제는 그 탭에서 끝난다. 퍼피티어가 띄운 크롬은 프로세스와 함께
 * 닫히므로, 끝내기 전에 waitBuyers() 로 사람이 탭을 닫을 때까지 기다린다.
 */
import { basename } from "node:path";
import { log, sleep } from "../log.js";
import {
  agreeHere, BOT_CHECK_SAID, BuyBrowserError, buyOnPage, dumpPayment, openBuyer, PAID_ANYWAY, payHere, pickPayMethod,
  PG_OPENED, PG_UNSEEN, SESSION_DEAD, type BotWait, type Buyer, type Pressed,
} from "./browser.js";
import type { BuyTarget, Config, Stage } from "./config.js";
import type { Discord } from "./discord.js";
import { enterPin } from "./pin.js";
import { js } from "./press.js";
import type { Watcher } from "./session.js";

/** 띄워 둔 탭들. 놓아 버리면 프로세스가 끝날 때 결제 중인 탭까지 닫힌다. */
const OPEN_BUYERS: Buyer[] = [];

export function lastBuyer(): Buyer | null {
  return OPEN_BUYERS.filter((b) => !b.isGone).at(-1) ?? null;
}

/** 띄워 둔 사는 탭이 있으면 사람이 다 닫을 때까지 기다린다. */
export async function waitBuyers(): Promise<void> {
  const open = OPEN_BUYERS.filter((b) => !b.isGone);
  if (!open.length) return;
  log.info(`🪟 사는 탭 ${open.length}개가 열려 있습니다 — 탭을 다 닫으면 끝납니다 (Ctrl+C 를 누르면 창째로 끝냅니다)`);
  let onInt = (): void => undefined;
  const interrupted = new Promise<void>((resolve) => {
    onInt = resolve;
    process.once("SIGINT", onInt);
  });
  await Promise.race([Promise.all(open.map((b) => b.closed)), interrupted]);
  process.off("SIGINT", onInt);
}

/** 이 창을 이미 받아 적었는가. --dump-pay 가 같은 판을 두 번 적지 않게 센다. */
const DUMPED = new WeakSet<Buyer>();

export async function dumpHere(buyer: Buyer, path: string): Promise<boolean> {
  if (DUMPED.has(buyer)) return true;
  try {
    if (await dumpPayment(buyer, path)) {
      DUMPED.add(buyer);
      log.info(`📝 화면을 적어 뒀습니다: ${basename(path)} (사람 정보는 가렸습니다)`);
      return true;
    }
  } catch (e) {
    log.warn(`받아 적지 못했습니다 — ${(e as Error).message}`);
  }
  return false;
}

const PIN_DONE = "스마일페이 비밀번호까지 넣었습니다";

/**
 * 인증 화면에서 비밀번호를 넣는다. → [자판 결과, 사유 (다 넣었으면 null)]
 * 틀렸다고 다시 넣어 보지는 않는다 — 몇 번 틀리면 잠긴다.
 */
async function pinTail(buyer: Buyer, pin: string, timeout: number): Promise<[Pressed, string | null]> {
  let result: Pressed;
  try {
    result = await enterPin(buyer, pin, Math.min(timeout, 15));
  } catch (e) {
    const why = `비밀번호를 넣다 끊겼습니다 — ${(e as Error).message.split("\n")[0]}`;
    log.warn(why);
    return ["none", why];
  }
  if (result === "ok") {
    log.info(`⭐ ${PIN_DONE}`);
    return ["ok", null];
  }
  const why = result === "quiet"
    ? "비밀번호를 넣다 멈췄거나, 다 넣었는데 자판이 그대로입니다 (틀렸거나 확인 화면이 더 있습니다)"
    : "비밀번호 자판을 못 찾았습니다";
  log.warn(`${why} — 나머지는 창에서 직접 해주세요`);
  return [result, why];
}

/**
 * 주문서에 도착했다. 설정에 따라 동의·결제수단·결제하기·비밀번호까지 누른다. → [어디까지 갔나, 한 줄 설명]
 *
 * **여기서 나는 어떤 오류도 위로 올리지 않는다.** 롯데온 판이 데인 자리다 — 주문서에
 * 도착한 뒤 창이 사라지자 오류가 감시 루프까지 뚫고 올라가 프로그램을 통째로 끝냈고,
 * 받아적기도 못 했다.
 */
async function sayArrived(cfg: Config, buyer: Buyer, dumpPath: string): Promise<[Stage, string]> {
  const b = cfg.buy;
  if (b.orderAction === "open") {
    log.info("✅ 주문서까지 갔습니다 — 결제는 창에서 직접 해주세요");
    return ["opened", "주문서를 열어 뒀습니다"];
  }

  let stage: Stage = "opened";
  let note = "";
  const tail = async (): Promise<[Stage, string]> => {
    if (stage !== "submitted") log.info(buyer.isGone ? "창이 사라졌습니다" : "주문서는 열려 있습니다 — 결제는 창에서 직접 해주세요");
    // 어긋났을 때, 그리고 비밀번호를 사람이 넣는 판이면 받아 적는다. G마켓 주문서·결제창은
    // 아직 받아 적은 적이 없다 — 사람이 자판을 누르는 동안이라 잃는 것이 없다.
    const clean = note === PG_OPENED && !!b.pgPassword;
    if (b.pgDump && !clean && note !== PAID_ANYWAY && !note.startsWith(PIN_DONE)) {
      if (note === PG_OPENED) await sleep(2500); // 창이 먼저 서고 자판이 뒤에 그려진다
      await dumpHere(buyer, dumpPath);
    }
    return [stage, note];
  };

  try {
    const agreeWhy = await agreeHere(buyer);
    if (agreeWhy) {
      note = agreeWhy;
      log.warn(`필수 동의에서 멈췄습니다 — ${note}`);
      return await tail();
    }
    stage = "agreed";
    if (b.orderAction === "agree") {
      note = "필수 동의까지 했습니다";
      log.info(`✅ ${note} — 결제는 창에서 직접 해주세요`);
      return ["agreed", note];
    }

    if (b.payMethod.length) {
      const payWhy = await pickPayMethod(buyer, b.payMethod, b.payMethodMark);
      if (payWhy) {
        note = payWhy;
        log.warn(`결제하기를 누르지 않았습니다 — ${note}`);
        return await tail();
      }
    }

    log.info(b.pgPassword
      ? `➡ 결제하기를 누릅니다 — 스마일페이 비밀번호(${b.pgPassword.length}자리)도 넣습니다`
      : "➡ 결제하기를 누릅니다 — 비밀번호는 넣지 않습니다");
    let pressed: boolean;
    [pressed, note] = await payHere(buyer, b.browserTimeoutSeconds);

    // **누른 것과 결제창이 뜬 것은 다르다.** 사이트가 alert 로 막은 것도 "눌린" 것이다.
    if (!pressed) {
      log.warn(`결제하기를 못 눌렀습니다 — ${note}`);
    } else if (note === PAID_ANYWAY) {
      log.error(`${note} — 이 계정은 결제 비밀번호를 묻지 않습니다. order_action 을 agree 로 되돌려 주세요.`);
      stage = "submitted";
    } else if (note === PG_OPENED || note === PG_UNSEEN) {
      stage = "submitted";
      if (!b.pgPassword) {
        if (note === PG_OPENED) log.info(`✅ ${note} — 비밀번호는 창에서 직접 넣어주세요`);
        else log.warn(note);
      } else {
        // 신호를 못 봤어도(PG_UNSEEN) 자판은 찾아본다. 못 찾으면 "none" 으로 물러난다.
        const [, why] = await pinTail(buyer, b.pgPassword, b.browserTimeoutSeconds);
        note = why ?? PIN_DONE;
      }
    } else {
      log.warn(`결제창까지 못 갔습니다 — ${note}`);
    }
  } catch (e) {
    note = `주문서에서 누르다 끊겼습니다 — ${(e as Error).message.split("\n")[0]}`;
    log.warn(note);
  }
  return tail();
}

/**
 * 결제가 끝나기를 지켜보다가, 끝나면 디스코드로 알린다. → 알렸으면 true
 * **화면 글자는 주문서를 떠났을 때만 믿는다** — 주문서 안에도 "주문완료" 같은 단계 표시가
 * 붙을 수 있어서, 서 있으면서 글자로 판정하면 결제를 시작하자마자 끝난 것으로 읽는다.
 */
export async function watchUntilPaid(cfg: Config, discord: Discord, buyer: Buyer, target: BuyTarget, name: string): Promise<boolean> {
  const { paidWaitMinutes: minutes, paidMarkers: markers } = cfg.buy;
  if (!minutes || !markers.length || !cfg.buy.notify.includes("paid")) return false;
  const orderUrl = buyer.page.url().split("?")[0] ?? "";
  const deadline = Date.now() + minutes * 60_000;
  log.info(`⏳ 결제가 끝나기를 지켜봅니다 (최대 ${minutes}분)`);

  while (Date.now() < deadline) {
    if (buyer.isGone) {
      log.warn("창이 닫혀 결제 완료를 지켜보지 못했습니다.");
      return false;
    }
    for (const page of buyer.pages()) {
      const where = page.url();
      const text = await js<string>(page, "document.body ? document.body.innerText || '' : ''").catch(() => "");
      const byUrl = markers.some((m) => where.includes(m));
      const byText = !!orderUrl && !where.startsWith(orderUrl) && !where.includes("item.gmarket.co.kr") && markers.some((m) => text.includes(m));
      if (byUrl || byText) {
        log.debug(`결제 완료로 봅니다 (${byUrl ? "주소" : "화면 글자"}) — ${where}`);
        const sent = await discord.buyPaid(cfg, target, name);
        log.info(sent ? "⭐ 결제 완료 — 디스코드로 알렸습니다" : "⭐ 결제 완료 — 알림은 못 보냈습니다");
        return sent;
      }
    }
    await sleep(2000);
  }
  log.warn(`${minutes}분 안에 결제 완료를 못 봤습니다. 창을 확인해 주세요.`);
  return false;
}

// 사이트가 "이미 다 팔렸다" 고 한 말들. 주문서가 뜨는 사이 소진된 것이다.
const SOLD_OUT_WORDS = ["품절", "소진", "재고가 부족", "재고가 없", "판매가 종료", "판매종료", "구매가 불가"];

/**
 * **고장이 아니라 경쟁에서 진 것인가.** 고장은 다시 해도 같으니 쉬어야 하지만, 품절로
 * 진 것은 취소분이 풀리면 곧장 다시 가야 한다. 쉬어 버리면 그 취소분을 놓친다.
 */
export function lostRace(reason: string | null | undefined): boolean {
  return !!reason && SOLD_OUT_WORDS.some((w) => reason.includes(w));
}

export interface BuyResult {
  ok: boolean;
  reason: string | null;
  stage: Stage;
  note: string;
  /** 세션이 끊겼는가. 그것만 다시 해봐야 소용없는 실패라 따로 돌려준다. */
  dead: boolean;
  buyer: Buyer | null;
}

/**
 * 사는 탭을 열어 상품을 열고 구매하기를 누르고, 시킨 데까지 간다.
 * 못 갔을 때 탭은 남긴다(마지막 한 번). 어디서 멈췄는지 사람이 봐야 판단이 된다.
 *
 * @param bot 봇 확인이 떴을 때 사람을 얼마나 기다리고 누구에게 알릴지.
 */
export async function doBuy(
  cfg: Config, watcher: Watcher, target: BuyTarget, ea: number, dumpPath: string, dryRun = false, bot?: BotWait,
): Promise<BuyResult> {
  const fail = (reason: string | null, extra: Partial<BuyResult> = {}): BuyResult =>
    ({ ok: false, reason, stage: "opened", note: "", dead: false, buyer: null, ...extra });

  if (dryRun) {
    log.info(`[dry-run] 여기서 구매하기를 눌렀을 것입니다 (×${ea}) — ${target.url}`);
    return { ok: true, reason: null, stage: "opened", note: "dry-run", dead: false, buyer: null };
  }

  const attempts = cfg.buy.maxAttempts;
  let last: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let buyer: Buyer;
    try {
      buyer = await openBuyer(watcher);
    } catch (e) {
      if (!(e instanceof BuyBrowserError)) throw e;
      log.warn(`사는 탭을 열지 못했습니다 — ${e.message.split("\n")[0]}`);
      return fail(e.message);
    }
    OPEN_BUYERS.push(buyer);
    await buyer.page.bringToFront().catch(() => undefined);

    let ok: boolean;
    let reason: string | null;
    try {
      [ok, reason] = await buyOnPage(buyer, target.url, {
        option: target.option, ea, timeout: cfg.buy.browserTimeoutSeconds, bot: bot ?? { seconds: cfg.buy.botCheckWaitSeconds },
      });
    } catch (e) {
      [ok, reason] = [false, `구매하기를 누르는 중 오류: ${(e as Error).message.split("\n")[0]}`];
    }

    if (ok) {
      const [stage, note] = await sayArrived(cfg, buyer, dumpPath);
      return { ok: true, reason: null, stage, note, dead: false, buyer };
    }

    last = reason;
    if (reason === SESSION_DEAD) return fail(reason, { dead: true, buyer });
    log.warn(`주문서까지 못 갔습니다 (${attempt}/${attempts}) — ${reason}`);
    // 품절은 다시 눌러 봐야 같은 말을 듣는다. 사람이 안 마친 봇 확인도 다시 연다고 풀리지 않는다.
    // 탭을 남기고 접는다.
    if (lostRace(reason) || reason === BOT_CHECK_SAID) return fail(reason, { buyer });
    if (attempt < attempts) {
      OPEN_BUYERS.splice(OPEN_BUYERS.indexOf(buyer), 1);
      await buyer.quit();
      await sleep(cfg.buy.retryDelaySeconds * 1000);
    }
  }
  return fail(last, { buyer: lastBuyer() });
}
