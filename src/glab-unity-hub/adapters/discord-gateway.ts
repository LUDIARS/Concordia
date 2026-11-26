/**
 * GLab の Discord guild への読み書き (DiscordGateway の discord.js 実装)。
 *
 * Hub worker は本社・子会社の Bot と同じ token で別の gateway 接続を張る。 同じ token の
 * Client は全 guild のイベントを受けるので、 **GLab の guild 以外のイベントは入口で捨てる**。
 *
 * - 権限は本人 (member) の権限で計算する (`permissionsFor(member)`)。
 * - 投稿は Webhook で本人の表示名・アイコンを名乗る。 Webhook を使えない場所
 *   (権限不足・返信付き・作れないチャンネル) は Bot が「<表示名> (Unity):」を先頭に付けて送る。
 * - 上流の失敗は `upstream_unavailable` に落とす。
 *
 * @implements spec/feature/glab-unity-hub.md §2 (GUH-DISCORD)
 */

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import { HubError } from "../domain/protocol.js";
import type {
  ChannelAccess,
  ChannelSummary,
  DiscordGateway,
  HubMember,
  MessageSummary,
  OverseasNotifier,
} from "../application/ports.js";

/** Hub が作る Webhook の名前。 既にあれば使い回す。 */
export const HUB_WEBHOOK_NAME = "GLab Unity Hub";
const MEMBER_CACHE_MS = 60_000;

type Postable = TextChannel | NewsChannel | ThreadChannel;

export function unityPrefixed(displayName: string, content: string): string {
  return `${displayName} (Unity): ${content}`.slice(0, 2000);
}

export function toMessageSummary(message: Pick<Message, "id" | "content" | "createdAt" | "attachments" | "reference" | "author" | "member">): MessageSummary {
  const summary: MessageSummary = {
    id: message.id,
    authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((attachment) => ({ name: attachment.name, url: attachment.url })),
  };
  const replyTo = message.reference?.messageId;
  return replyTo ? { ...summary, replyTo } : summary;
}

function isPostable(channel: unknown): channel is Postable {
  const type = (channel as { type?: ChannelType } | null)?.type;
  return type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement
    || type === ChannelType.PublicThread || type === ChannelType.PrivateThread || type === ChannelType.AnnouncementThread;
}

function upstream(error: unknown): never {
  if (error instanceof HubError) throw error;
  throw new HubError("upstream_unavailable", "Discord is unavailable");
}

export class DiscordJsGateway implements DiscordGateway, OverseasNotifier {
  private readonly members = new Map<string, { member: GuildMember | null; at: number }>();

  constructor(
    private readonly client: Client,
    private readonly guildId: string,
    private readonly options: { bugReportChannelId: string | null; notifyUserId: string | null },
  ) {}

  /** worker が呼ぶ: 必要最小限の intent で gateway に入る。 */
  static createClient(): Client {
    return new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
      partials: [Partials.GuildMember],
    });
  }

  async member(discordUserId: string): Promise<HubMember | null> {
    const member = await this.guildMember(discordUserId);
    if (!member) return null;
    return { discordUserId, displayName: member.displayName, avatarUrl: member.displayAvatarURL() };
  }

  async listChannels(): Promise<ChannelSummary[]> {
    try {
      const guild = await this.guild();
      const channels = await guild.channels.fetch();
      const result: ChannelSummary[] = [];
      for (const channel of channels.values()) {
        if (!channel) continue;
        if (channel.type === ChannelType.GuildText) result.push({ id: channel.id, name: channel.name, parentId: channel.parentId, kind: "text" });
        if (channel.type === ChannelType.GuildAnnouncement) result.push({ id: channel.id, name: channel.name, parentId: channel.parentId, kind: "announcement" });
      }
      const threads = await guild.channels.fetchActiveThreads();
      for (const thread of threads.threads.values()) {
        const parent = thread.parent;
        result.push({
          id: thread.id, name: thread.name, parentId: thread.parentId,
          kind: parent?.type === ChannelType.GuildForum ? "forum_post" : "thread",
        });
      }
      return result;
    } catch (error) {
      return upstream(error);
    }
  }

  async access(discordUserId: string, channelId: string): Promise<ChannelAccess | null> {
    const channel = await this.channel(channelId);
    if (!channel) return null;
    const member = await this.guildMember(discordUserId);
    if (!member) return { view: false, readHistory: false, send: false, react: false };
    const permissions = channel.permissionsFor(member);
    if (!permissions) return { view: false, readHistory: false, send: false, react: false };
    const thread = channel.isThread();
    return {
      view: permissions.has(PermissionFlagsBits.ViewChannel),
      readHistory: permissions.has(PermissionFlagsBits.ReadMessageHistory),
      send: permissions.has(thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages)
        && !(thread && channel.locked === true),
      react: permissions.has(PermissionFlagsBits.AddReactions),
    };
  }

  async listMessages(channelId: string, input: { before?: string; limit: number }): Promise<MessageSummary[]> {
    const channel = await this.requireChannel(channelId);
    try {
      const messages = await channel.messages.fetch({ limit: Math.min(50, Math.max(1, input.limit)), ...(input.before ? { before: input.before } : {}) });
      return [...messages.values()].map(toMessageSummary);
    } catch (error) {
      return upstream(error);
    }
  }

  async postAs(member: HubMember, channelId: string, input: { content: string; replyTo?: string }): Promise<{ messageId: string }> {
    const channel = await this.requireChannel(channelId);
    try {
      // Webhook は返信 (message reference) を付けられないので、 返信は Bot の名乗り付き投稿にする。
      if (!input.replyTo) {
        const viaWebhook = await this.postViaWebhook(channel, member, input.content);
        if (viaWebhook) return { messageId: viaWebhook };
      }
      const sent = await channel.send({
        content: unityPrefixed(member.displayName, input.content),
        allowedMentions: { parse: [] },
        ...(input.replyTo ? { reply: { messageReference: input.replyTo, failIfNotExists: false } } : {}),
      });
      return { messageId: sent.id };
    } catch (error) {
      return upstream(error);
    }
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.requireChannel(channelId);
    try {
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    } catch (error) {
      if ((error as { code?: number }).code === 10008) throw new HubError("not_found", "message not found");
      if ((error as { code?: number }).code === 10014) throw new HubError("invalid_request", "unknown emoji");
      return upstream(error);
    }
  }

  async uploadLogs(input: { title: string; reporter: HubMember; files: readonly { name: string; content: Buffer }[] }): Promise<Array<{ name: string; url: string }>> {
    if (!this.options.bugReportChannelId) throw new HubError("upstream_unavailable", "glabUnityHub.bugReportChannelId is not configured");
    const channel = await this.channel(this.options.bugReportChannelId);
    if (!channel) throw new HubError("upstream_unavailable", "bug report channel is not available");
    try {
      const sent = await channel.send({
        content: `🐞 Melpomene のログ: ${input.title.slice(0, 200)} (${input.reporter.displayName} / Unity)`,
        allowedMentions: { parse: [] },
        files: input.files.map((file) => ({ attachment: file.content, name: file.name })),
      });
      return [...sent.attachments.values()].map((attachment) => ({ name: attachment.name, url: attachment.url }));
    } catch (error) {
      return upstream(error);
    }
  }

  onMessage(listener: (channelId: string, message: MessageSummary) => void): () => void {
    const handler = (message: Message) => {
      if (message.guildId !== this.guildId) return;
      listener(message.channelId, toMessageSummary(message));
    };
    this.client.on("messageCreate", handler);
    return () => { this.client.off("messageCreate", handler); };
  }

  onMemberLeave(listener: (discordUserId: string) => void): () => void {
    const handler = (member: { guild: { id: string }; id: string }) => {
      if (member.guild.id !== this.guildId) return;
      this.members.delete(member.id);
      listener(member.id);
    };
    this.client.on("guildMemberRemove", handler);
    return () => { this.client.off("guildMemberRemove", handler); };
  }

  /** 海外接続の通知 (neco への DM)。 宛先が無ければ何もしない。 */
  async notify(input: { tokenLabel: string | null; discordUserId: string; country: string | null; maskedIp: string | null; policy: string; blocked: boolean }): Promise<void> {
    if (!this.options.notifyUserId) return;
    const user = await this.client.users.fetch(this.options.notifyUserId);
    await user.send({
      content: [
        `🌏 GLab-UnityHub: 許可国外からの接続 (${input.blocked ? "遮断" : "監視のみ"})`,
        `- 利用者: <@${input.discordUserId}> (トークン: ${input.tokenLabel ?? "ラベルなし"})`,
        `- 国: ${input.country ?? "不明"} / 送信元: ${input.maskedIp ?? "不明"}`,
        `- 方針: ${input.policy}。 同じトークン・同じ国の通知は 1 時間に 1 回まで。`,
      ].join("\n"),
      allowedMentions: { parse: [] },
    });
  }

  private async postViaWebhook(channel: Postable, member: HubMember, content: string): Promise<string | null> {
    const parent = channel.isThread() ? channel.parent : channel;
    if (!parent || !("fetchWebhooks" in parent)) return null;
    const me = parent.guild.members.me;
    if (!me || !parent.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) return null;
    try {
      const hooks = await parent.fetchWebhooks();
      const owned = hooks.find((hook) => hook.name === HUB_WEBHOOK_NAME && hook.owner?.id === this.client.user?.id);
      const webhook = owned ?? await parent.createWebhook({ name: HUB_WEBHOOK_NAME, reason: "GLab-UnityHub: Unity からの投稿" });
      const sent = await webhook.send({
        content,
        username: `${member.displayName} (Unity)`.slice(0, 80),
        ...(member.avatarUrl ? { avatarURL: member.avatarUrl } : {}),
        allowedMentions: { parse: [] },
        ...(channel.isThread() ? { threadId: channel.id } : {}),
      });
      return sent.id;
    } catch {
      return null;
    }
  }

  private async guild(): Promise<Guild> {
    return this.client.guilds.cache.get(this.guildId) ?? this.client.guilds.fetch(this.guildId);
  }

  private async guildMember(discordUserId: string): Promise<GuildMember | null> {
    const cached = this.members.get(discordUserId);
    if (cached && Date.now() - cached.at < MEMBER_CACHE_MS) return cached.member;
    try {
      const guild = await this.guild();
      const member = await guild.members.fetch(discordUserId);
      this.members.set(discordUserId, { member, at: Date.now() });
      return member;
    } catch (error) {
      // 10007 Unknown Member / 10013 Unknown User は「GLab にいない」。 それ以外は上流障害。
      const code = (error as { code?: number }).code;
      if (code === 10007 || code === 10013) {
        this.members.set(discordUserId, { member: null, at: Date.now() });
        return null;
      }
      return upstream(error);
    }
  }

  private async channel(channelId: string): Promise<Postable | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !isPostable(channel) || channel.guildId !== this.guildId) return null;
      return channel;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 10003 || code === 50001) return null;
      return upstream(error);
    }
  }

  private async requireChannel(channelId: string): Promise<Postable> {
    const channel = await this.channel(channelId);
    if (!channel) throw new HubError("not_found", "channel not found in GLab");
    return channel;
  }
}
