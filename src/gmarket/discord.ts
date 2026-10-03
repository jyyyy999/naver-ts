/**
 * 디스코드 알림. 진행 상황은 화면에서 보고, **손댈 차례만 폰으로 받는다.**
 * 재입고 알림은 파이썬 판(gmarket_item_stock.py)의 notify_restock 과 같은 꼴이다.
 */
import { log } from "../log.js";
import type { BuyTarget, Config, Stage } from "./config.js";
import { priceText, type ItemInfo } from "./parse.js";

interface Embed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  thumbnail?: { url: string };
}

const COLOR = { green: 0x2ecc71, orange: 0xe67e22, red: 0xe74c3c, gray: 0x95a5a6, blue: 0x3498db, amber: 0xf39c12 };
const FOOTER = "G마켓 바로구매";
const now = (): string => new Date().toISOString();

/** 어디까지 갔는지 한 줄로. 폰으로 보는 사람이 무엇을 해야 하는지 알아야 한다. */
const STAGE_SAID: Record<Stage, [string, string]> = {
  opened: ["🛒 주문서를 열었습니다", "PC 의 창에서 결제해 주세요"],
  agreed: ["🛒 주문서에서 필수 동의까지 했습니다", "PC 의 창에서 결제해 주세요"],
  submitted: ["💳 결제하기까지 눌렀습니다", "비밀번호·결제 확정은 PC 의 창을 봐주세요"],
};

export class Discord {
  constructor(
    private readonly webhookUrl: string,
    private readonly dryRun: boolean,
  ) {}

  async post(payload: { content: string | null; embeds: Embed[] }): Promise<boolean> {
    if (this.dryRun) {
      log.info(`[dry-run] 디스코드 전송 생략: ${payload.embeds[0]?.title ?? payload.content ?? ""}`);
      return true;
    }
    if (!this.webhookUrl) return false; // --buy 는 웹훅 없이도 부를 수 있다
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
        if (r.status === 429 && attempt === 0) {
          const wait = Number(((await r.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1);
          await new Promise((res) => setTimeout(res, Math.min(wait, 10) * 1000 + 200));
          continue;
        }
        if (r.status >= 300) {
          log.error(`디스코드 전송 실패 (${r.status}): ${(await r.text()).slice(0, 300)}`);
          return false;
        }
        log.debug(`디스코드 전송 완료 (${r.status})`);
        return true;
      } catch (e) {
        log.error(`디스코드 전송 중 오류: ${String(e)}`);
        return false;
      }
    }
    return false;
  }

  async alert(title: string, description: string, color = COLOR.red, mention = ""): Promise<boolean> {
    return this.post({ content: mention || null, embeds: [{ title, description, color, footer: { text: FOOTER }, timestamp: now() }] });
  }

  /** 품절 → 구매가능. 파이썬 판과 같은 알림이다. */
  async restock(cfg: Config, info: ItemInfo, wasOutFor: string | null, buying: boolean): Promise<boolean> {
    const lines = ["**재고가 들어왔습니다. 지금 구매할 수 있습니다.**"];
    if (wasOutFor) lines.push(`품절 상태로 ${wasOutFor} 있었습니다.`);
    if (buying) lines.push("🛒 바로구매 대상이라 구매 창을 띄웁니다.");
    lines.push(info.url);
    return this.post({
      content: cfg.restockMention || null,
      embeds: [{
        title: `🚨 ${info.name}`.slice(0, 250),
        url: info.url,
        description: lines.join("\n"),
        color: COLOR.red,
        fields: [
          { name: "가격", value: priceText(info.price), inline: true },
          { name: "상품번호", value: `\`${info.code}\``, inline: true },
          ...(info.limitText ? [{ name: "구매 한도", value: info.limitText, inline: true }] : []),
        ],
        ...(info.image ? { thumbnail: { url: info.image } } : {}),
        footer: { text: FOOTER },
        timestamp: now(),
      }],
    });
  }

  /** Cloudflare 봇 확인. **사람이 PC 창에서 마쳐야** 풀린다 — 그래서 멘션을 붙인다. */
  async botCheck(cfg: Config, where: string, waitSeconds: number): Promise<boolean> {
    return this.post({
      content: cfg.buy.mention || cfg.restockMention || null,
      embeds: [{
        title: "🤖 G마켓이 봇 확인을 띄웠습니다",
        color: COLOR.amber,
        description: `${where}\nPC 의 크롬 창에서 **직접 확인을 마쳐 주세요.** 프로그램은 확인 화면을 누르지 않습니다.\n` +
          `${Math.round(waitSeconds / 60)}분 기다린 뒤에도 그대로면 물러났다가 다시 봅니다.`,
        footer: { text: FOOTER },
        timestamp: now(),
      }],
    });
  }

  async test(cfg: Config): Promise<boolean> {
    return this.post({
      content: "✅ G마켓 바로구매 웹훅 연결 테스트",
      embeds: [{
        title: "이 채널로 재입고·구매 알림이 옵니다",
        description: `감시 상품 **${cfg.codes.length}개** · 구매 대상 **${cfg.buy.targets.length}개**\n확인 주기 **${cfg.intervalSeconds}초**`,
        color: COLOR.blue,
      }],
    });
  }

  private wants(cfg: Config, event: string): boolean {
    return cfg.buy.notify.includes(event);
  }

  async buyOpened(cfg: Config, target: BuyTarget, info: ItemInfo, stage: Stage, note: string): Promise<boolean> {
    if (!this.wants(cfg, "opened")) return false;
    const [title, footer] = STAGE_SAID[stage];
    return this.post({
      content: cfg.buy.mention || null,
      embeds: [{
        title,
        url: target.url,
        color: COLOR.green,
        description: `${target.label || info.name}\n${note}`.trim(),
        fields: [
          { name: "가격", value: priceText(info.price), inline: true },
          { name: "수량", value: `${target.ea}개`, inline: true },
          { name: "옵션", value: target.option || "—", inline: true },
        ],
        footer: { text: footer },
        timestamp: now(),
      }],
    });
  }

  async buyBlocked(cfg: Config, target: BuyTarget, reason: string): Promise<boolean> {
    if (!this.wants(cfg, "blocked")) return false;
    return this.post({
      content: null,
      embeds: [{ title: "⛔ 사지 않았습니다", url: target.url, color: COLOR.orange, description: reason, footer: { text: FOOTER }, timestamp: now() }],
    });
  }

  async buySession(cfg: Config, extra = ""): Promise<boolean> {
    if (!this.wants(cfg, "session")) return false;
    return this.post({
      content: cfg.buy.mention || null,
      embeds: [{
        title: "🔒 G마켓 로그인이 풀렸습니다",
        color: COLOR.red,
        description: `재고가 열려도 살 수 없습니다.${extra ? `\n${extra}` : ""}\nPC 에서 \`.\\gm --login\` 으로 다시 로그인해 주세요.`,
        footer: { text: FOOTER },
        timestamp: now(),
      }],
    });
  }

  /** 결제가 끝났다. 이 알림 하나 받자고 지켜본 것이다. */
  async buyPaid(cfg: Config, target: BuyTarget, name: string): Promise<boolean> {
    if (!this.wants(cfg, "paid")) return false;
    const product = (name || target.label || target.url).slice(0, 200);
    return this.post({
      content: null,
      embeds: [{
        title: "successfully checkout",
        url: target.url,
        color: COLOR.green,
        description: product,
        fields: [
          { name: "제품", value: product, inline: false },
          { name: "링크", value: target.url, inline: false },
        ],
        footer: { text: "결제 완료" },
        timestamp: now(),
      }],
    });
  }

  static readonly amber = COLOR.amber;
  static readonly gray = COLOR.gray;
  static readonly green = COLOR.green;
}
