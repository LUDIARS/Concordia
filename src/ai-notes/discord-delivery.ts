import { z } from "zod";
import { composeNotice, type Destination, type Publication, type Receipt, type SendResult } from "./model.js";
import { deliveryJson, DeliveryFault, failedDelivery } from "./http-delivery.js";

type DiscordDestination = Exclude<Destination, { kind: "slack-channel" }>;
const ChannelSchema = z.object({ id: z.string(), guild_id: z.string(), type: z.number(), parent_id: z.string().nullable().optional(),
  flags: z.number().optional(), available_tags: z.array(z.object({ id: z.string() })).optional() });
const MessageSchema = z.object({ id: z.string(), channel_id: z.string(), content: z.string(), author: z.object({ id: z.string(), bot: z.boolean().optional() }) });

export interface DiscordPublicationDeps {
  config: () => { enabled: boolean; token: string | null };
  fetcher: typeof fetch;
}

function request(deps: DiscordPublicationDeps) {
  const config = deps.config();
  if (!config.enabled || !config.token) throw new DeliveryFault("discord_not_configured");
  return (path: string, body?: unknown) => deliveryJson({ url: `https://discord.com/api/v10${path}`,
    authorization: `Bot ${config.token}`, body, fetcher: deps.fetcher });
}

async function validateTarget(get: ReturnType<typeof request>, target: DiscordDestination): Promise<void> {
  const channel = ChannelSchema.parse(await get(`/channels/${target.channel_id}`));
  if (channel.id !== target.channel_id || channel.guild_id !== target.guild_id) throw new DeliveryFault("discord_target_mismatch");
  if (target.kind === "discord-channel") {
    if (channel.type !== 0 && channel.type !== 5) throw new DeliveryFault("discord_text_channel_required");
  } else {
    if (channel.type !== 15) throw new DeliveryFault("discord_forum_required");
    const tags = channel.available_tags ?? [];
    if (target.applied_tags.some(id => !tags.some(tag => tag.id === id))) throw new DeliveryFault("discord_forum_tag_missing");
    if (((channel.flags ?? 0) & 16) !== 0 && !target.applied_tags.length) throw new DeliveryFault("discord_forum_tag_required");
  }
}

function receipt(target: DiscordDestination, messageId: string, channelId: string): Receipt {
  return { message_id: messageId, channel_id: channelId, message_url: `https://discord.com/channels/${target.guild_id}/${channelId}/${messageId}` };
}

export async function sendDiscordPublication(deps: DiscordPublicationDeps, row: Publication & { target: DiscordDestination }, ownsAttempt: () => boolean): Promise<SendResult> {
  let writing = false;
  try {
    const get = request(deps);
    await validateTarget(get, row.target);
    const message = { content: composeNotice(row.article), allowed_mentions: { parse: [], replied_user: false } };
    if (!ownsAttempt()) throw new DeliveryFault("delivery_claim_lost");
    writing = true;
    if (row.target.kind === "discord-forum") {
      const result = z.object({ id: z.string(), parent_id: z.string(), message: MessageSchema }).parse(
        await get(`/channels/${row.target.channel_id}/threads`, {
          name: row.article.title.slice(0, 100).replace(/[\uD800-\uDBFF]$/u, ""), applied_tags: row.target.applied_tags, message,
        }));
      if (result.parent_id !== row.target.channel_id || result.message.channel_id !== result.id) throw new DeliveryFault("discord_receipt_mismatch", true);
      return { status: "sent", receipt: receipt(row.target, result.message.id, result.id) };
    }
    const result = MessageSchema.parse(await get(`/channels/${row.target.channel_id}/messages`, message));
    if (result.channel_id !== row.target.channel_id) throw new DeliveryFault("discord_receipt_mismatch", true);
    return { status: "sent", receipt: receipt(row.target, result.id, result.channel_id) };
  } catch (error) { return failedDelivery(error, writing); }
}

export async function verifyDiscordPublication(deps: DiscordPublicationDeps, row: Publication & { target: DiscordDestination }, messageId: string, channelId: string): Promise<Receipt | null> {
  if (!/^[1-9]\d{16,19}$/.test(messageId) || !/^[1-9]\d{16,19}$/.test(channelId)) return null;
  try {
    const get = request(deps);
    const channel = ChannelSchema.parse(await get(`/channels/${channelId}`));
    if (channel.guild_id !== row.target.guild_id || channel.id !== channelId) return null;
    if (row.target.kind === "discord-forum") {
      if (channel.type !== 11 || channel.parent_id !== row.target.channel_id) return null;
    } else if (channel.id !== row.target.channel_id || (channel.type !== 0 && channel.type !== 5)) return null;
    const me = z.object({ id: z.string() }).parse(await get("/users/@me"));
    const message = MessageSchema.parse(await get(`/channels/${channelId}/messages/${messageId}`));
    if (message.id !== messageId || message.channel_id !== channelId || message.author.id !== me.id || !message.author.bot
      || message.content !== composeNotice(row.article)) return null;
    return receipt(row.target, messageId, channelId);
  } catch { return null; }
}
