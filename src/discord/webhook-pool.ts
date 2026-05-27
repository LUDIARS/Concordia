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
const whLog = createChildLogger("webhook-pool");
const VERBOSE = "[verbose-cs-bug]";

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
      `${VERBOSE} webhook-pool.getForSession lookup`,
    );
    if (!row) {
      whLog.warn({ sessionId }, `${VERBOSE} webhook-pool.getForSession no session-channel row`);
      return null;
    }
    if (row.webhook_id && row.webhook_token) {
      const cached = this.cache.get(row.channel_id);
      if (cached) {
        whLog.info({ sessionId, channel_id: row.channel_id }, `${VERBOSE} webhook-pool.getForSession cache hit`);
        return cached;
      }
      const client = new WebhookClient({ id: row.webhook_id, token: row.webhook_token });
      this.cache.set(row.channel_id, client);
      whLog.info({ sessionId, channel_id: row.channel_id, webhook_id: row.webhook_id }, `${VERBOSE} webhook-pool.getForSession new client from DB token`);
      return client;
    }
    // webhook が未作成 → channel に作る
    const ch = this.guild.channels.cache.get(row.channel_id) ?? null;
    if (!ch || ch.type !== ChannelType.GuildText) {
      whLog.warn({ sessionId, channel_id: row.channel_id, ch_type: ch?.type ?? null }, `${VERBOSE} webhook-pool.getForSession channel not text`);
      return null;
    }
    try {
      const wh = await (ch as TextChannel).createWebhook({ name: WEBHOOK_NAME });
      if (!wh.token) {
        whLog.warn({ sessionId, channel_id: row.channel_id, webhook_id: wh.id }, `${VERBOSE} webhook-pool.getForSession createWebhook no token`);
        return null;
      }
      this.repo.setWebhook(sessionId, wh.id, wh.token);
      const client = new WebhookClient({ id: wh.id, token: wh.token });
      this.cache.set(row.channel_id, client);
      whLog.info({ sessionId, channel_id: row.channel_id, webhook_id: wh.id }, `${VERBOSE} webhook-pool.getForSession new webhook created`);
      return client;
    } catch (err) {
      whLog.warn({ sessionId, channel_id: row.channel_id, err: (err as Error).message }, `${VERBOSE} webhook-pool.getForSession createWebhook threw`);
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
      const msg = await client.send(options);
      return { id: msg.id };
    } catch {
      return null;
    }
  }
}
