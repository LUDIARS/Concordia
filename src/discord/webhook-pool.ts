// channel ごとに webhook を 1 つ用意して per-message に username/avatar を
// 上書きする pool。
//
// Webhook は Discord 上の永続オブジェクト. token を DB に保存しておけば
// bot 再起動後も同じ webhook を再利用できる. token が無ければ channel を
// fetch → create する.

import type { Guild, TextChannel, WebhookMessageCreateOptions } from "discord.js";
import { ChannelType, WebhookClient } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { runClaude } from "../rules/claude-runner.js";

const WEBHOOK_NAME = "Concordia";
const DISCORD_MESSAGE_MAX = 2000;
// claude -p の --model エイリアス (LUDIARS は API 不使用 = CLI 経由).
const SPLIT_MODEL = "haiku";
const whLog = createChildLogger("webhook-pool");

export class WebhookPool {
  private cache = new Map<string, WebhookClient>(); // channel_id → WebhookClient
  // channel_id → 進行中の webhook 取得 promise.
  // 主経路はセッション登録時 (onSessionRegistered) の eager 作成なので、 通常は
  // egress 到来時には DB に token があり ensureWebhookForChannel を踏まない。
  // この inflight 集約は fallback パス (eager 失敗 / meta channel / 旧 session)
  // で並行 cache miss が来たときの保険: セッション開始直後は transcript.frame /
  // chat.posted が並行到来し、 全部が cache miss → createWebhook を雷鳴的に連打して
  // 1 channel あたり Discord 上限 15 webhook に到達 → egress が死ぬ. これを
  // channel 単位で 1 本に集約して防ぐ.
  private inflight = new Map<string, Promise<WebhookClient | null>>();

  constructor(
    private readonly guild: Guild,
    private readonly repo: DiscordSessionChannelsRepo,
  ) {}

  /**
   * sessionId に紐づく webhook を取得 (DB → cache → 新規作成 の順).
   * 失敗時 (channel が無い等) は null.
   */
  async getForSession(sessionId: string): Promise<WebhookClient | null> {
    const row = this.repo.findBySessionId(sessionId);
    whLog.info(
      {
        sessionId,
        row_channel_id: row?.channel_id ?? null,
        row_webhook_id: row?.webhook_id ?? null,
        row_has_token: row?.webhook_token ? true : false,
        cache_size: this.cache.size,
      },
      "webhook-pool.getForSession lookup",
    );
    if (!row) {
      whLog.warn({ sessionId }, "webhook-pool.getForSession no session-channel row");
      return null;
    }
    if (row.webhook_id && row.webhook_token) {
      const cached = this.cache.get(row.channel_id);
      if (cached) {
        whLog.info({ sessionId, channel_id: row.channel_id }, "webhook-pool.getForSession cache hit");
        return cached;
      }
      const client = new WebhookClient({ id: row.webhook_id, token: row.webhook_token });
      this.cache.set(row.channel_id, client);
      whLog.info({ sessionId, channel_id: row.channel_id, webhook_id: row.webhook_id }, "webhook-pool.getForSession new client from DB token");
      return client;
    }
    // webhook が未作成 → channel に作る (in-flight 集約 + 既存再利用).
    // 作成できたら session 行にも token を永続化する.
    return this.ensureWebhookForChannel(row.channel_id, (id, token) => {
      this.repo.setWebhook(sessionId, id, token);
    }, sessionId);
  }

  /** session に紐づかない meta channel 用. */
  async getForChannel(channelId: string, _opts: { storeTokenAs?: string } = {}): Promise<WebhookClient | null> {
    return this.ensureWebhookForChannel(channelId);
  }

  /**
   * channel 上の bot 所有 webhook (`Concordia`) を全削除し cache/inflight からも除く.
   * session 終了 → archive 時に呼ぶ。 archived channel が Discord の webhook budget
   * (1 channel 15 個) を握り続けて新規 channel を枯渇させるのを防ぐ。 best-effort
   * (失敗は warn のみ)。 削除した webhook 数を返す。
   */
  async purgeChannel(channelId: string): Promise<number> {
    this.cache.delete(channelId);
    this.inflight.delete(channelId);
    const ch = this.guild.channels.cache.get(channelId) ?? null;
    if (!ch || ch.type !== ChannelType.GuildText) return 0;
    let deleted = 0;
    try {
      const hooks = await (ch as TextChannel).fetchWebhooks();
      for (const w of hooks.values()) {
        if (w.name !== WEBHOOK_NAME || w.owner?.id !== this.guild.client.user?.id) continue;
        try {
          await w.delete("session ended → archive: free webhook budget");
          deleted += 1;
        } catch (err) {
          whLog.warn({ channel_id: channelId, webhook_id: w.id, err: (err as Error).message }, "webhook-pool.purgeChannel delete failed");
        }
      }
    } catch (err) {
      whLog.warn({ channel_id: channelId, err: (err as Error).message }, "webhook-pool.purgeChannel fetch failed");
    }
    if (deleted > 0) whLog.info({ channel_id: channelId, deleted }, "webhook-pool.purgeChannel done");
    return deleted;
  }

  /**
   * channel に webhook を **1 つだけ** 用意する共通経路.
   *  - cache hit ならそれを返す
   *  - 同一 channel への並行呼び出しは in-flight promise を共有 (雷鳴的 create 防止)
   *  - 既存の bot 所有 webhook (`Concordia`) を再利用してから create にフォールバック
   *    → Discord の 1 channel あたり 15 webhook 上限への到達を防ぐ
   * @param persist token 永続化コールバック (session 行 / config 等). 省略時は永続化しない.
   */
  private ensureWebhookForChannel(
    channelId: string,
    persist?: (webhookId: string, token: string) => void,
    sessionId?: string,
  ): Promise<WebhookClient | null> {
    const cached = this.cache.get(channelId);
    if (cached) return Promise.resolve(cached);
    const existing = this.inflight.get(channelId);
    if (existing) return existing;

    const p = (async (): Promise<WebhookClient | null> => {
      const ch = this.guild.channels.cache.get(channelId) ?? null;
      if (!ch || ch.type !== ChannelType.GuildText) {
        whLog.warn({ sessionId, channel_id: channelId, ch_type: ch?.type ?? null }, "webhook-pool.ensure channel not text");
        return null;
      }
      try {
        const found = (await (ch as TextChannel).fetchWebhooks()).find(
          (w) => w.name === WEBHOOK_NAME && w.owner?.id === this.guild.client.user?.id,
        );
        const wh = found ?? (await (ch as TextChannel).createWebhook({ name: WEBHOOK_NAME }));
        if (!wh.token) {
          whLog.warn({ sessionId, channel_id: channelId, webhook_id: wh.id }, "webhook-pool.ensure webhook has no token");
          return null;
        }
        persist?.(wh.id, wh.token);
        const client = new WebhookClient({ id: wh.id, token: wh.token });
        this.cache.set(channelId, client);
        whLog.info(
          { sessionId, channel_id: channelId, webhook_id: wh.id, reused: !!found },
          "webhook-pool.ensure webhook ready",
        );
        return client;
      } catch (err) {
        whLog.warn({ sessionId, channel_id: channelId, err: (err as Error).message }, "webhook-pool.ensure createWebhook threw");
        return null;
      } finally {
        this.inflight.delete(channelId);
      }
    })();
    this.inflight.set(channelId, p);
    return p;
  }

  /** 安全な send. 失敗時は null を返す. 成功時に Discord message id を返す. */
  async send(
    client: WebhookClient,
    options: WebhookMessageCreateOptions,
  ): Promise<{ id: string } | null> {
    try {
      const content = typeof options.content === "string" ? options.content : null;
      if (!content || content.length <= DISCORD_MESSAGE_MAX) {
        const msg = await client.send(options);
        return { id: msg.id };
      }

      const chunks = await splitForDiscord(content, DISCORD_MESSAGE_MAX);
      let firstId: string | null = null;
      for (const chunk of chunks) {
        const msg = await client.send({ ...options, content: chunk });
        if (!firstId) firstId = msg.id;
      }
      return firstId ? { id: firstId } : null;
    } catch {
      return null;
    }
  }
}

async function splitForDiscord(text: string, maxLen: number): Promise<string[]> {
  try {
    const prompt =
      "Split the following text into natural chunks for Discord posting.\n" +
      `Rules:\n` +
      `- Each chunk must be <= ${maxLen} characters.\n` +
      "- Preserve the original text exactly. Do not rewrite or summarize.\n" +
      "- Split on semantic boundaries when possible (paragraph/sentence).\n" +
      "- Return JSON only: {\"chunks\":[\"...\", ...]}\n\n" +
      `Text:\n${text}`;
    // LUDIARS は API 不使用. claude -p (サブスク Haiku) で分割する.
    const r = await runClaude(prompt, { model: SPLIT_MODEL });
    if (!r.ok) return fallbackSplit(text, maxLen);
    const parsed = extractChunks(r.stdout);
    if (!parsed.length || parsed.some((c) => c.length > maxLen)) return fallbackSplit(text, maxLen);
    return parsed;
  } catch (err) {
    whLog.warn({ err: (err as Error).message }, "webhook-pool split with claude failed; fallback");
    return fallbackSplit(text, maxLen);
  }
}

function extractChunks(raw: string): string[] {
  const obj = parseJsonObject(raw);
  if (!obj || !Array.isArray((obj as any).chunks)) return [];
  const chunks = (obj as any).chunks.filter((v: unknown): v is string => typeof v === "string");
  return chunks.map((s: string) => s.trim()).filter(Boolean);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try { return JSON.parse(raw.trim()) as Record<string, unknown>; } catch { /* continue */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  if (fence) {
    try { return JSON.parse(fence[1].trim()) as Record<string, unknown>; } catch { /* continue */ }
  }
  const obj = /\{[\s\S]*\}/.exec(raw);
  if (obj) {
    try { return JSON.parse(obj[0]) as Record<string, unknown>; } catch { return null; }
  }
  return null;
}

function fallbackSplit(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = Math.max(
      rest.lastIndexOf("\n\n", maxLen),
      rest.lastIndexOf("\n", maxLen),
      rest.lastIndexOf("。", maxLen),
      rest.lastIndexOf(". ", maxLen),
      rest.lastIndexOf(" ", maxLen),
    );
    if (cut <= 0) cut = maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out.push(rest);
  return out.length ? out : [text.slice(0, maxLen)];
}
