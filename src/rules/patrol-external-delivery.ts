/**
 * 巡回投稿の個別チャンネル配送 (spec/feature/patrol-chat.md §8 個別チャンネル)。
 *
 * action_config.discord_channel_id を指定した巡回投稿は、 本社の chat 配信 (meta channel webhook / Slack) を通さず、
 * 本社 Bot の token で指定チャンネルへ直接送る。 子会社 guild には本社と同じ Bot が招待されている
 * (spec/feature/subsidiary-delegation.md §1) ので、 同じ token で届く。
 *
 * - 宛先 guild は本社 guild と有効な子会社 guild に限る (allowlist)。 それ以外は送らない
 * - 名乗りを出すため、 チャンネルの巡回用 webhook を使う。 webhook を作れない (権限不足) ときは
 *   Bot 本人の投稿に名乗りを太字で前置する
 * - 自動再送はしない。 送れなかった run は配達照合で delivery_unknown になる (CC-PATROL-03)
 */

const API = "https://discord.com/api/v10";
export const PATROL_WEBHOOK_NAME = "Concordia 巡回";

export interface ExternalChannelPostInput {
  channelId: string;
  content: string;
  username: string | null;
}

export interface ExternalDeliveryDeps {
  /** 本社 Bot の token。 未設定なら null。 */
  botToken: () => string | null;
  /** 投稿してよい guild (本社 + 有効な子会社)。 */
  allowedGuildIds: () => readonly string[];
  fetchImpl?: typeof fetch;
}

export type ExternalChannelPoster = (input: ExternalChannelPostInput) => Promise<{ messageId: string }>;

interface WebhookRef { id: string; token: string }

export function makeExternalChannelPoster(deps: ExternalDeliveryDeps): ExternalChannelPoster {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const webhooks = new Map<string, WebhookRef | "unavailable">();

  async function api(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    return fetchImpl(`${API}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  async function ensureWebhook(token: string, channelId: string): Promise<WebhookRef | null> {
    const cached = webhooks.get(channelId);
    if (cached) return cached === "unavailable" ? null : cached;
    const listed = await api(token, `/channels/${channelId}/webhooks`);
    if (listed.ok) {
      const hooks = (await listed.json()) as Array<{ id: string; token?: string; name?: string }>;
      const found = hooks.find((h) => h.name === PATROL_WEBHOOK_NAME && h.token);
      if (found?.token) {
        const ref = { id: found.id, token: found.token };
        webhooks.set(channelId, ref);
        return ref;
      }
      const created = await api(token, `/channels/${channelId}/webhooks`, { method: "POST", body: { name: PATROL_WEBHOOK_NAME } });
      if (created.ok) {
        const hook = (await created.json()) as { id: string; token?: string };
        if (hook.token) {
          const ref = { id: hook.id, token: hook.token };
          webhooks.set(channelId, ref);
          return ref;
        }
      }
    }
    // 権限不足 (Manage Webhooks なし) など。 以後は Bot 本人の投稿で送る
    webhooks.set(channelId, "unavailable");
    return null;
  }

  return async ({ channelId, content, username }) => {
    if (!/^\d{17,20}$/.test(channelId)) throw new Error(`invalid Discord channel id: ${channelId}`);
    const token = deps.botToken();
    if (!token) throw new Error("HQ Discord bot token is not configured");
    const channel = await api(token, `/channels/${channelId}`);
    if (!channel.ok) throw new Error(`Discord channel lookup failed (${channel.status})`);
    const guildId = ((await channel.json()) as { guild_id?: string }).guild_id ?? null;
    if (!guildId || !deps.allowedGuildIds().includes(guildId)) {
      throw new Error(`Discord channel ${channelId} is not in the HQ or an enabled subsidiary guild`);
    }
    const allowed_mentions = { parse: [] as string[] };
    const hook = await ensureWebhook(token, channelId);
    if (hook) {
      const res = await fetchImpl(`${API}/webhooks/${hook.id}/${hook.token}?wait=true`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, allowed_mentions, ...(username ? { username } : {}) }),
      });
      if (res.ok) return { messageId: ((await res.json()) as { id: string }).id };
      // webhook が消された等。 次回は作り直す
      webhooks.delete(channelId);
      throw new Error(`Discord webhook rejected the post (${res.status})`);
    }
    const res = await api(token, `/channels/${channelId}/messages`, {
      method: "POST",
      body: { content: username ? `**${username}**\n${content}` : content, allowed_mentions },
    });
    if (!res.ok) throw new Error(`Discord channel rejected the post (${res.status})`);
    return { messageId: ((await res.json()) as { id: string }).id };
  };
}
