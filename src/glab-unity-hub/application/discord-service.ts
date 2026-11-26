/**
 * `discord.*` メソッド (契約 v1 §2)。 すべて **本人の権限** で絞る。
 *
 * - channels.list: 本人が閲覧できるテキストチャンネル・スレッドだけ。
 * - messages.list: 閲覧 + 履歴の権限があるチャンネルだけ。
 * - messages.post: 送信権限があるチャンネルだけ。 Webhook で本人の表示名・アイコンを名乗る
 *   (使えない場所は Bot が「<表示名> (Unity):」を先頭に付ける — adapter の責務)。
 * - reactions.add: 閲覧 + リアクション権限。
 * - subscribe: 閲覧 + 履歴の権限。 以後 `event: discord.message` を push する。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-DISCORD)
 */

import { HubError } from "../domain/protocol.js";
import type { HubPayload } from "../domain/methods.js";
import type { ChannelAccess, ChannelSummary, DiscordGateway, MessageSummary } from "./ports.js";
import type { MethodContext } from "./method-context.js";

export const DEFAULT_MESSAGE_LIMIT = 50;

export class HubDiscordService {
  constructor(private readonly discord: DiscordGateway) {}

  async listChannels(context: MethodContext): Promise<{ channels: ChannelSummary[] }> {
    const userId = context.identity.token.discordUserId;
    const channels = await this.discord.listChannels();
    const visible: ChannelSummary[] = [];
    for (const channel of channels) {
      const access = await this.discord.access(userId, channel.id);
      if (access?.view) visible.push(channel);
    }
    return { channels: visible };
  }

  async listMessages(context: MethodContext, payload: HubPayload<"discord.messages.list">): Promise<{ messages: MessageSummary[] }> {
    await this.require(context, payload.channelId, (access) => access.view && access.readHistory);
    const messages = await this.discord.listMessages(payload.channelId, {
      ...(payload.before ? { before: payload.before } : {}),
      limit: payload.limit ?? DEFAULT_MESSAGE_LIMIT,
    });
    return { messages };
  }

  async post(context: MethodContext, payload: HubPayload<"discord.messages.post">): Promise<{ messageId: string }> {
    await this.require(context, payload.channelId, (access) => access.view && access.send);
    return this.discord.postAs(context.identity.member, payload.channelId, {
      content: payload.content,
      ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    });
  }

  async react(context: MethodContext, payload: HubPayload<"discord.reactions.add">): Promise<Record<string, never>> {
    await this.require(context, payload.channelId, (access) => access.view && access.readHistory && access.react);
    await this.discord.react(payload.channelId, payload.messageId, payload.emoji);
    return {};
  }

  async subscribe(context: MethodContext, payload: HubPayload<"discord.subscribe">): Promise<Record<string, never>> {
    await this.require(context, payload.channelId, (access) => access.view && access.readHistory);
    context.subscriptions.subscribe(payload.channelId);
    return {};
  }

  async unsubscribe(context: MethodContext, payload: HubPayload<"discord.unsubscribe">): Promise<Record<string, never>> {
    context.subscriptions.unsubscribe(payload.channelId);
    return {};
  }

  /** 購読者がまだそのチャンネルを読めるか (通知の直前に見直す)。 */
  async canStillRead(discordUserId: string, channelId: string): Promise<boolean> {
    const access = await this.discord.access(discordUserId, channelId);
    return access !== null && access.view && access.readHistory;
  }

  private async require(context: MethodContext, channelId: string, allowed: (access: ChannelAccess) => boolean): Promise<void> {
    const access = await this.discord.access(context.identity.token.discordUserId, channelId);
    if (!access) throw new HubError("not_found", "channel not found in GLab");
    if (!allowed(access)) throw new HubError("forbidden", "you do not have permission for this channel");
  }
}
