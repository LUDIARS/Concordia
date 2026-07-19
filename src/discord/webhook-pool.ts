// channel ごとに webhook を 1 つ用意して per-message に username/avatar を
// 上書きする pool。
//
// Webhook は Discord 上の永続オブジェクト. token を DB に保存しておけば
// bot 再起動後も同じ webhook を再利用できる. token が無ければ channel を
// fetch → create する.

import type { Guild, WebhookMessageCreateOptions } from "discord.js";
import { ChannelType, WebhookClient } from "discord.js";
import type { DiscordSessionChannelRow, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { formatForChunkedPost } from "../shared/message-blocks.js";

const WEBHOOK_NAME = "Concordia";
const DISCORD_MESSAGE_MAX = 2000;
const DEFAULT_WEBHOOK_SEND_TIMEOUT_MS = 12_000;
const DEFAULT_WEBHOOK_RATE_LIMIT_RETRY_MS = 15_000;
const WEBHOOK_FALLBACK_THRESHOLD_MS = 30_000;
const WEBHOOK_SEND_SPACING_MS = 500;
const whLog = createChildLogger("webhook-pool");

function webhookSendTimeoutMs(): number {
  const raw = process.env.CONCORDIA_DISCORD_WEBHOOK_SEND_TIMEOUT_MS;
  if (!raw) return DEFAULT_WEBHOOK_SEND_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WEBHOOK_SEND_TIMEOUT_MS;
}

function webhookSendAbortSignal(): AbortSignal {
  const timeoutMs = webhookSendTimeoutMs();
  return AbortSignal.timeout(timeoutMs);
}

function webhookToken(client: WebhookClient): string | null {
  return (client as unknown as { token?: string | null }).token ?? null;
}

function webhookMessageChannelId(message: unknown): string | undefined {
  const value = message as { channelId?: unknown; channel_id?: unknown };
  return typeof value.channelId === "string"
    ? value.channelId
    : typeof value.channel_id === "string"
      ? value.channel_id
      : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function webhookRetryAfterMs(res: Response): Promise<number> {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }
  const body = await res.clone().json().catch(() => null) as { retry_after?: number } | null;
  if (body?.retry_after && Number.isFinite(body.retry_after) && body.retry_after > 0) {
    return Math.ceil(body.retry_after * 1000);
  }
  return DEFAULT_WEBHOOK_RATE_LIMIT_RETRY_MS;
}

export class WebhookPool {
  private cache = new Map<string, WebhookClient>(); // channel_id → WebhookClient
  private webhookChannels = new Map<string, string>(); // webhook_id → channel_id
  private sessionClients = new Map<string, WebhookClient>(); // forum thread session → targeted client
  private sessionInflight = new Map<string, Promise<WebhookClient | null>>();
  private threadTargets = new WeakMap<WebhookClient, string>(); // targeted client → thread_id
  private sendQueues = new Map<string, Promise<void>>(); // webhook_id → serialized sends
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
    const existing = this.sessionInflight.get(sessionId);
    if (existing) return existing;
    const pending = this.resolveSessionWebhook(sessionId);
    this.sessionInflight.set(sessionId, pending);
    try {
      return await pending;
    } finally {
      if (this.sessionInflight.get(sessionId) === pending) {
        this.sessionInflight.delete(sessionId);
      }
    }
  }

  private async resolveSessionWebhook(sessionId: string): Promise<WebhookClient | null> {
    const row = this.repo.findBySessionId(sessionId);
    if (!row) {
      whLog.warn({ sessionId }, "webhook-pool.getForSession no session-channel row");
      return null;
    }
    const target = await this.resolveSessionWebhookTarget(row);
    if (!target) return null;
    if (row.webhook_id && row.webhook_token) {
      const sessionClient = this.sessionClients.get(sessionId);
      if (sessionClient) return sessionClient;
      const cached = this.cache.get(target.webhookChannelId);
      if (cached && !target.threadId) return cached;
      const client = new WebhookClient({ id: row.webhook_id, token: row.webhook_token });
      this.webhookChannels.set(row.webhook_id, target.webhookChannelId);
      if (target.threadId) {
        this.sessionClients.set(sessionId, client);
        this.threadTargets.set(client, target.threadId);
      } else {
        this.cache.set(target.webhookChannelId, client);
      }
      return client;
    }
    // Forum thread は親 forum に共有 webhook を 1 本だけ作り、送信 client に thread_id
    // を束縛する。従来 channel はその channel 自身を webhook target にする。
    const base = await this.ensureWebhookForChannel(target.webhookChannelId, undefined, sessionId);
    if (!base) return null;
    const token = webhookToken(base);
    if (!token) return null;
    this.repo.setWebhook(sessionId, base.id, token);
    if (!target.threadId) return base;
    const client = new WebhookClient({ id: base.id, token });
    this.sessionClients.set(sessionId, client);
    this.threadTargets.set(client, target.threadId);
    return client;
  }

  /** Ended forum thread の session-scoped client 参照を解放する。親 webhook は共有なので残す。 */
  releaseSession(sessionId: string): void {
    this.sessionClients.delete(sessionId);
  }

  /** session に紐づかない meta channel 用. */
  async getForChannel(channelId: string, _opts: { storeTokenAs?: string } = {}): Promise<WebhookClient | null> {
    return this.ensureWebhookForChannel(channelId);
  }

  /** Parent Forum webhook から starter を投稿し、新規 thread を作る。 */
  async createForumThread(
    forumId: string,
    options: WebhookMessageCreateOptions & { content: string; threadName: string },
  ): Promise<{ threadId: string; messageId: string; webhookId: string; webhookToken: string } | null> {
    const client = await this.getForChannel(forumId);
    if (!client) return null;
    const token = webhookToken(client);
    if (!token) return null;
    const sent = await this.send(client, options);
    if (!sent?.channelId) {
      whLog.warn({ forum_id: forumId, webhook_id: client.id }, "webhook-pool forum create missing thread id");
      return null;
    }
    return {
      threadId: sent.channelId,
      messageId: sent.id,
      webhookId: client.id,
      webhookToken: token,
    };
  }

  /** webhook authored Forum surface message を session-scoped token で更新する。 */
  async editForSession(sessionId: string, messageId: string, content: string): Promise<boolean> {
    const client = await this.getForSession(sessionId);
    if (!client) return false;
    const token = webhookToken(client);
    if (!token) return false;
    const threadId = this.threadTargets.get(client);
    const threadQuery = threadId ? `?thread_id=${encodeURIComponent(threadId)}` : "";
    try {
      const res = await fetch(
        `https://discord.com/api/v10/webhooks/${client.id}/${token}/messages/${messageId}${threadQuery}`,
        {
          method: "PATCH",
          signal: webhookSendAbortSignal(),
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (res.ok) return true;
      const body = await res.text().catch(() => "");
      whLog.warn(
        { sessionId, message_id: messageId, status: res.status, body: body.slice(0, 200) },
        "webhook-pool edit failed",
      );
      return false;
    } catch (error) {
      whLog.warn({ sessionId, message_id: messageId, err: (error as Error).message }, "webhook-pool edit threw");
      return false;
    }
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
    for (const [webhookId, mappedChannelId] of this.webhookChannels) {
      if (mappedChannelId === channelId) this.webhookChannels.delete(webhookId);
    }
    const ch = this.guild.channels.cache.get(channelId) ?? null;
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildForum)) return 0;
    let deleted = 0;
    try {
      const hooks = await ch.fetchWebhooks();
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
      if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildForum)) {
        whLog.warn({ sessionId, channel_id: channelId, ch_type: ch?.type ?? null }, "webhook-pool.ensure channel not text");
        return null;
      }
      try {
        const found = (await ch.fetchWebhooks()).find(
          (w) => w.name === WEBHOOK_NAME && w.owner?.id === this.guild.client.user?.id,
        );
        const wh = found ?? (await ch.createWebhook({ name: WEBHOOK_NAME }));
        if (!wh.token) {
          whLog.warn({ sessionId, channel_id: channelId, webhook_id: wh.id }, "webhook-pool.ensure webhook has no token");
          return null;
        }
        persist?.(wh.id, wh.token);
        const client = new WebhookClient({ id: wh.id, token: wh.token });
        this.cache.set(channelId, client);
        this.webhookChannels.set(wh.id, channelId);
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
  ): Promise<{ id: string; channelId?: string } | null> {
    const threadId = options.threadId ?? this.threadTargets.get(client);
    const targetedOptions = threadId ? { ...options, threadId } : options;
    const previous = this.sendQueues.get(client.id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.sendNow(client, targetedOptions));
    const tail = run.then(() => undefined, () => undefined);
    this.sendQueues.set(client.id, tail);
    tail.finally(() => {
      if (this.sendQueues.get(client.id) === tail) this.sendQueues.delete(client.id);
    }).catch(() => undefined);
    return run;
  }

  private async sendNow(
    client: WebhookClient,
    options: WebhookMessageCreateOptions,
  ): Promise<{ id: string; channelId?: string } | null> {
    try {
      await sleep(WEBHOOK_SEND_SPACING_MS);
      const content = typeof options.content === "string" ? options.content : null;
      if (content === null) {
        const msg = await client.send(options);
        const channelId = webhookMessageChannelId(msg);
        return { id: msg.id, ...(channelId ? { channelId } : {}) };
      }

      // テーブルを ``` で囲み、 上限超なら ``` ブロックをまたがず分割する
      // (テーブル/コードブロックがメッセージ境界で割れて崩れるのを防ぐ)。
      const chunks = formatForChunkedPost(content, DISCORD_MESSAGE_MAX);
      let first: { id: string; channelId?: string } | null = null;
      for (const chunk of chunks) {
        const msg = await this.sendTextChunk(client, { ...options, content: chunk });
        if (!first) first = msg;
      }
      return first;
    } catch (err) {
      whLog.warn(
        {
          webhook_id: client.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "webhook-pool.send failed",
      );
      return null;
    }
  }

  private async sendTextChunk(
    client: WebhookClient,
    options: WebhookMessageCreateOptions & { content: string },
  ): Promise<{ id: string; channelId?: string }> {
    if (options.files?.length) {
      const msg = await client.send(options);
      const channelId = webhookMessageChannelId(msg);
      return { id: msg.id, ...(channelId ? { channelId } : {}) };
    }
    const token = webhookToken(client);
    if (!token) throw new Error("Discord webhook token unavailable");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const threadQuery = options.threadId ? `&thread_id=${encodeURIComponent(options.threadId)}` : "";
      const res = await fetch(`https://discord.com/api/v10/webhooks/${client.id}/${token}?wait=true${threadQuery}`, {
        method: "POST",
        signal: webhookSendAbortSignal(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: options.content,
          username: options.username,
          avatar_url: options.avatarURL,
          allowed_mentions: options.allowedMentions,
          embeds: options.embeds,
          components: options.components,
          thread_name: options.threadName,
          applied_tags: options.appliedTags,
        }),
      });
      if (res.status === 429 && attempt < 2) {
        const retryMs = await webhookRetryAfterMs(res);
        if (retryMs >= WEBHOOK_FALLBACK_THRESHOLD_MS && (options.threadName || options.threadId)) {
          throw new Error(`Discord forum webhook rate limited for ${retryMs}ms`);
        }
        if (retryMs >= WEBHOOK_FALLBACK_THRESHOLD_MS && !options.threadName && !options.threadId) {
          whLog.warn(
            { webhook_id: client.id, retry_ms: retryMs },
            "webhook-pool.send rate limited too long; falling back to bot send",
          );
          return this.sendTextChunkViaBot(client, options);
        }
        whLog.warn(
          { webhook_id: client.id, retry_ms: retryMs, attempt: attempt + 1 },
          "webhook-pool.send rate limited; retrying",
        );
        await sleep(retryMs);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Discord webhook HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const json = await res.json() as { id?: string; channel_id?: string };
      if (!json.id) throw new Error("Discord webhook response missing message id");
      return { id: json.id, ...(json.channel_id ? { channelId: json.channel_id } : {}) };
    }
    throw new Error("Discord webhook send retry exhausted");
  }

  private async sendTextChunkViaBot(
    client: WebhookClient,
    options: WebhookMessageCreateOptions & { content: string },
  ): Promise<{ id: string; channelId?: string }> {
    const channelId = this.webhookChannels.get(client.id);
    if (!channelId) throw new Error("Discord webhook fallback channel unavailable");
    const targetId = options.threadId ?? channelId;
    const ch = this.guild.channels.cache.get(targetId) ?? await this.guild.channels.fetch(targetId).catch(() => null);
    if (!ch || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.PublicThread)) {
      throw new Error("Discord webhook fallback target is not sendable text");
    }
    const author = typeof options.username === "string" && options.username.trim() ? options.username.trim() : null;
    const content = author ? `**${author}**\n${options.content}` : options.content;
    const msg = await ch.send({
      content,
      allowedMentions: options.allowedMentions,
      embeds: options.embeds,
      components: options.components,
    });
    return { id: msg.id, channelId: msg.channelId };
  }

  private async resolveSessionWebhookTarget(
    row: DiscordSessionChannelRow,
  ): Promise<{ webhookChannelId: string; threadId?: string } | null> {
    if (row.channel_kind !== "thread") return { webhookChannelId: row.channel_id };
    const thread = this.guild.channels.cache.get(row.channel_id)
      ?? await this.guild.channels.fetch(row.channel_id).catch(() => null);
    if (!thread || thread.type !== ChannelType.PublicThread || !thread.parentId) {
      whLog.warn({ sessionId: row.session_id, thread_id: row.channel_id }, "webhook-pool forum thread unavailable");
      return null;
    }
    const parent = this.guild.channels.cache.get(thread.parentId)
      ?? await this.guild.channels.fetch(thread.parentId).catch(() => null);
    if (!parent || parent.type !== ChannelType.GuildForum) {
      whLog.warn({ sessionId: row.session_id, thread_id: row.channel_id, parent_id: thread.parentId }, "webhook-pool thread parent is not forum");
      return null;
    }
    return { webhookChannelId: parent.id, threadId: thread.id };
  }
}
