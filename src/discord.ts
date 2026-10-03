import { log } from "./log.js";
import { imageUrl, label, priceText, stockText } from "./parse.js";
import type { BuyTarget, Config, ProductInfo, Stage } from "./types.js";

export interface Embed {
  title: string;
  url?: string;
  description?: string;
  color: number;
  fields?: { name: string; value: string; inline: boolean }[];
  footer?: { text: string };
  timestamp?: string;
  image?: { url: string };
  thumbnail?: { url: string };
}

interface Payload {
  content: string | null;
  embeds: Embed[];
}

const COLOR = { green: 0x2ecc71, orange: 0xe67e22, red: 0xe74c3c, purple: 0x9b59b6, gray: 0x95a5a6, blue: 0x3498db, amber: 0xf39c12 };
const now = (): string => new Date().toISOString();

export class Discord {
  constructor(
    private readonly webhookUrl: string,
    private readonly dryRun: boolean,
  ) {}

  async post(payload: Payload): Promise<boolean> {
    if (this.dryRun) {
      log.info(`[dry-run] 디스코드 전송 생략:\n${JSON.stringify(payload, null, 2)}`);
      return true;
    }
    // --buy 는 웹훅 없이도 부를 수 있다. 없으면 조용히 건너뛴다.
    if (!this.webhookUrl) return false;
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
        log.info(`디스코드 전송 완료 (${r.status})`);
        return true;
      } catch (e) {
        log.error(`디스코드 전송 중 오류: ${String(e)}`);
        return false;
      }
    }
    return false;
  }

  /** 디스코드는 메시지 하나에 임베드 10개까지만 허용한다. */
  private async postChunked(header: string | null, embeds: Embed[]): Promise<void> {
    for (let i = 0; i < embeds.length; i += 10) {
      await this.post({ content: i === 0 ? header : null, embeds: embeds.slice(i, i + 10) });
    }
  }

  private baseEmbed(info: ProductInfo, color: number): Embed {
    const embed: Embed = {
      title: info.name,
      url: info.url,
      color,
      fields: [
        { name: "상태", value: label(info.status), inline: true },
        { name: "가격", value: priceText(info.price), inline: true },
        { name: "재고", value: stockText(info.stock), inline: true },
      ],
      footer: { text: `상품번호 ${info.productId}` },
      timestamp: now(),
    };
    const opts = optionSummary(info);
    if (opts) embed.fields!.push({ name: "옵션", value: opts, inline: false });
    return embed;
  }

  async change(cfg: Config, info: ProductInfo, prevStatus: string | null): Promise<void> {
    const restocked = info.inStock && !(prevStatus === "SALE");
    const embed = this.baseEmbed(info, restocked ? COLOR.green : COLOR.orange);
    embed.title = `${restocked ? "🔔 재입고!" : "재고 상태 변경"} — ${info.name}`;
    embed.fields!.unshift({ name: "변화", value: `${label(prevStatus)} → **${label(info.status)}**`, inline: false });
    const img = imageUrl(info);
    if (img) embed[restocked ? "image" : "thumbnail"] = { url: img };

    const content = restocked ? `${cfg.restockMention} 🔔 **${info.name}** 재입고! ${info.url}`.trim() : null;
    await this.post({ content, embeds: [embed] });
  }

  async startup(
    cfg: Config,
    results: { url: string; info?: ProductInfo; err?: string }[],
    perMin: number,
    nCategories: number,
  ): Promise<void> {
    const embeds = results.map<Embed>(({ url, info, err }) => {
      if (!info) return { title: "확인 실패", url, description: "```" + (err ?? "") + "```", color: COLOR.gray };
      const e = this.baseEmbed(info, info.inStock ? COLOR.green : COLOR.red);
      e.title = `${info.inStock ? "🟢" : "🔴"} ${info.name}`;
      const img = imageUrl(info, "f300");
      if (img) e.thumbnail = { url: img };
      return e;
    });
    const catNote = nCategories ? `, 신상품 감시 카테고리 ${nCategories}개` : "";
    await this.postChunked(
      `📦 스마트스토어 감시 시작 — 상품 ${results.length}개${catNote}, ${cfg.checkIntervalSeconds}초 간격 (약 ${perMin.toFixed(1)}회/분)`,
      embeds,
    );
  }

  async newProducts(cfg: Config, catUrl: string, items: ProductInfo[], total: number | null): Promise<void> {
    const embeds = items.map<Embed>((info) => {
      const e: Embed = {
        title: `🆕 ${info.name}`,
        url: info.url,
        color: COLOR.purple,
        fields: [
          { name: "가격", value: priceText(info.price), inline: true },
          { name: "상태", value: label(info.status), inline: true },
          { name: "재고", value: stockText(info.stock), inline: true },
        ],
        footer: { text: `상품번호 ${info.productId}` },
        timestamp: now(),
      };
      const img = imageUrl(info);
      if (img) e[items.length === 1 ? "image" : "thumbnail"] = { url: img };
      return e;
    });
    const header = `${cfg.newProductMention} 🆕 카테고리에 신상품 ${items.length}개 (전체 ${total ?? "?"}개)\n${catUrl}`.trim();
    await this.postChunked(header, embeds);
  }

  async alert(title: string, description: string, opts: { color?: number; mention?: string } = {}): Promise<void> {
    await this.post({
      content: opts.mention || null,
      embeds: [{ title, description, color: opts.color ?? COLOR.red, timestamp: now() }],
    });
  }

  async test(cfg: Config): Promise<boolean> {
    return this.post({
      content: "✅ 스마트스토어 재고 감시 웹훅 연결 테스트",
      embeds: [
        {
          title: "이 채널로 재입고 알림이 옵니다",
          description: `감시 상품 **${cfg.products.length}개**\n확인 주기 **${cfg.checkIntervalSeconds}초**`,
          color: COLOR.blue,
        },
      ],
    });
  }

  // --- 구매 쪽 알림. 진행 상황은 화면에서 보고, **손댈 차례만 폰으로 받는다.** ---
  // 무엇을 보낼지는 buy.notify 가 정한다 — 다 보내면 정작 중요한 것이 묻힌다.

  private wants(cfg: Config, event: string): boolean {
    return cfg.buy.notify.includes(event);
  }

  async buyOpened(cfg: Config, target: BuyTarget, info: ProductInfo, stage: Stage, note: string): Promise<boolean> {
    if (!this.wants(cfg, "opened")) return false;
    const [title, footer] = STAGE_SAID[stage];
    return this.post({
      content: cfg.buy.mention || null,
      embeds: [{
        title,
        url: target.url,
        color: COLOR.green,
        description: `${info.name}\n${note}`.trim(),
        fields: [
          { name: "가격", value: priceText(info.discounted ?? info.price), inline: true },
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
      embeds: [{ title: "⛔ 사지 않았습니다", url: target.url, color: COLOR.orange, description: reason, timestamp: now() }],
    });
  }

  async buySession(cfg: Config): Promise<boolean> {
    if (!this.wants(cfg, "session")) return false;
    return this.post({
      content: cfg.buy.mention || null,
      embeds: [{
        title: "🔒 네이버 로그인 세션이 끊겼습니다",
        color: COLOR.red,
        description: "재고가 열려도 살 수 없어 멈춥니다.\n`npm start -- --login` 으로 다시 로그인해 주세요.",
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
}

/** 어디까지 갔는지 한 줄로. 폰으로 보는 사람이 무엇을 해야 하는지 알아야 한다. */
const STAGE_SAID: Record<Stage, [string, string]> = {
  opened: ["🛒 주문서를 열었습니다", "PC 의 창에서 결제해 주세요"],
  submitted: ["💳 결제하기까지 눌렀습니다", "인증·결제 확정은 PC 의 창을 봐주세요"],
};

function optionSummary(info: ProductInfo, limit = 8): string | null {
  if (!info.options.length) return null;
  const inStock = info.options.filter((o) => o.stock);
  if (!inStock.length) return `옵션 ${info.options.length}개 전부 품절`;
  const lines = inStock.slice(0, limit).map((o) => `· ${o.name} — ${stockText(o.stock)}`);
  if (inStock.length > limit) lines.push(`… 외 ${inStock.length - limit}개`);
  return lines.join("\n");
}
