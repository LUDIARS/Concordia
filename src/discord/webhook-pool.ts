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

const WEBHOOK_NAME = "Concordia";
const DISCORD_MESSAGE_MAX = 2000;
const SPLIT_MODEL = "claude-haiku-4-5";
const whLog = createChildLogger("webhook-pool");

export class WebhookPool {
  private cache = new Map<string, WebhookClient>(); // channel_id → WebhookClient

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
    // webhook が未作成 → channel に作る
    const ch = this.guild.channels.cache.get(row.channel_id) ?? null;
    if (!ch || ch.type !== ChannelType.GuildText) {
      whLog.warn({ sessionId, channel_id: row.channel_id, ch_type: ch?.type ?? null }, "webhook-pool.getForSession channel not text");
      return null;
    }
    try {
      const wh = await (ch as TextChannel).createWebhook({ name: WEBHOOK_NAME });
      if (!wh.token) {
        whLog.warn({ sessionId, channel_id: row.channel_id, webhook_id: wh.id }, "webhook-pool.getForSession createWebhook no token");
        return null;
      }
      this.repo.setWebhook(sessionId, wh.id, wh.token);
      const client = new WebhookClient({ id: wh.id, token: wh.token });
      this.cache.set(row.channel_id, client);
      whLog.info({ sessionId, channel_id: row.channel_id, webhook_id: wh.id }, "webhook-pool.getForSession new webhook created");
      return client;
    } catch (err) {
      whLog.warn({ sessionId, channel_id: row.channel_id, err: (err as Error).message }, "webhook-pool.getForSession createWebhook threw");
      return null;
    }
  }

  /** session に紐づかない meta channel 用. token は DB の `discord_config` に持つ. */
  async getForChannel(channelId: string, opts: { storeTokenAs?: string } = {}): Promise<WebhookClient | null> {
    const cached = this.cache.get(channelId);
    if (cached) return cached;
    const ch = this.guild.channels.cache.get(channelId);
    if (!ch || ch.type !== ChannelType.GuildText) return null;
    try {
      const existing = (await (ch as TextChannel).fetchWebhooks()).find(
        (w) => w.name === WEBHOOK_NAME && w.owner?.id === this.guild.client.user?.id,
      );
      const wh =
        existing ?? (await (ch as TextChannel).createWebhook({ name: WEBHOOK_NAME }));
      if (!wh.token) return null;
      const client = new WebhookClient({ id: wh.id, token: wh.token });
      this.cache.set(channelId, client);
      return client;
    } catch {
      return null;
    }
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
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) return fallbackSplit(text, maxLen);
  try {
    const prompt =
      "Split the following text into natural chunks for Discord posting.\n" +
      `Rules:\n` +
      `- Each chunk must be <= ${maxLen} characters.\n` +
      "- Preserve the original text exactly. Do not rewrite or summarize.\n" +
      "- Split on semantic boundaries when possible (paragraph/sentence).\n" +
      "- Return JSON only: {\"chunks\":[\"...\", ...]}\n\n" +
      `Text:\n${text}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SPLIT_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fallbackSplit(text, maxLen);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const raw = data.content?.[0]?.text ?? "";
    const parsed = extractChunks(raw);
    if (!parsed.length || parsed.some((c) => c.length > maxLen)) return fallbackSplit(text, maxLen);
    return parsed;
  } catch (err) {
    whLog.warn({ err: (err as Error).message }, "webhook-pool split with haiku failed; fallback");
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
