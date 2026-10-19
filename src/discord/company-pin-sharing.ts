import { ChannelType, MessageFlags, MessageType, PermissionFlagsBits,
  type Client, type GuildBasedChannel, type Message } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { canSharePinnedContent, isSharedSaveAction, sharedContent } from "./company-pin-sharing-policy.js";

interface ShareSource { channelId: string; messageId: string }
export interface CompanyPinSharingDeps {
  client: Client;
  config: Pick<DiscordConfigRepo, "compareAndSwap">;
  target: () => { guildId: string; channelId: string } | null;
  isStopped: () => boolean;
  isPrivateOrForeign: (channelId: string) => boolean;
  log: { warn(message: string): void };
}

/** Only visibility-related overwrites matter; all roles/member exceptions must match. */
function audience(channel: GuildBasedChannel): string | null {
  if (channel.isThread()) return channel.type === ChannelType.PrivateThread || !channel.parent
    ? null : audience(channel.parent);
  if (!("permissionOverwrites" in channel)) return null;
  const mask = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
  return [...channel.permissionOverwrites.cache.values()]
    .map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield & mask, deny: o.deny.bitfield & mask }))
    .filter(o => o.allow !== 0n || o.deny !== 0n)
    .map(o => `${o.type}:${o.id}:${o.allow}:${o.deny}`).sort().join("|");
}

/** Discord I/O and one-attempt delivery ledger, owned by this company runtime. */
export class CompanyPinSharing {
  private active = 0;
  constructor(private readonly deps: CompanyPinSharingDeps) {}

  pinNotice(message: Message): void {
    if (message.type !== MessageType.ChannelPinnedMessage || !message.reference?.messageId) return;
    this.enqueue({ channelId: message.channelId, messageId: message.reference.messageId }, "pin");
  }

  workflow(action: string, source?: ShareSource): void {
    if (source && isSharedSaveAction(action)) this.enqueue(source, "save");
  }

  private enqueue(source: ShareSource, kind: "pin" | "save"): void {
    if (this.deps.isStopped()) return;
    if (this.active >= 4) {
      this.deps.log.warn("company-pin-sharing: capacity exceeded; not delivered");
      return;
    }
    this.active++;
    void this.deliver(source, kind).catch(() => {
      // Do not expose message content, URLs or Discord exception payloads in logs.
      this.deps.log.warn("company-pin-sharing: lookup or delivery failed; not confirmed");
    }).finally(() => { this.active--; });
  }

  /** @implements CC-PIN-01 CC-PIN-02 CC-PIN-03 CC-PIN-04 */
  private async deliver(source: ShareSource, kind: "pin" | "save"): Promise<void> {
    const target = this.deps.target();
    if (!target?.channelId) {
      this.deps.log.warn("company-pin-sharing: company chitchat is not configured");
      return;
    }
    if (source.channelId === target.channelId || this.deps.isPrivateOrForeign(source.channelId)) return;
    const channel = await this.deps.client.channels.fetch(source.channelId, { force: true });
    const destination = await this.deps.client.channels.fetch(target.channelId, { force: true });
    if (!channel || !destination || channel.isDMBased() || destination.isDMBased()
      || !channel.isTextBased() || destination.type !== ChannelType.GuildText) return;
    // Refresh the parent too: public thread permissions are inherited, not the cached thread's own ACL.
    if (channel.isThread() && channel.parentId) await channel.guild.channels.fetch(channel.parentId, { force: true });
    const audienceChannel = channel.isThread() ? channel.parent : channel;
    const ageRestricted = audienceChannel && "nsfw" in audienceChannel && audienceChannel.nsfw;
    if (!canSharePinnedContent({
      guildId: target.guildId, sourceGuildId: channel.guildId, targetGuildId: destination.guildId,
      sourceChannelId: channel.id, targetChannelId: destination.id,
      privateSource: channel.type === ChannelType.PrivateThread || Boolean(ageRestricted && !destination.nsfw),
      sourceAudience: audience(channel), targetAudience: audience(destination),
    })) {
      this.deps.log.warn("company-pin-sharing: audience or company mismatch; not shared");
      return;
    }
    const message = await channel.messages.fetch({ message: source.messageId, force: true });
    if (message.channelId !== source.channelId || (kind === "pin" && !message.pinned)) return;
    const me = destination.guild.members.me;
    const permissions = me && destination.permissionsFor(me);
    const rendered = sharedContent(message.content, message.url, kind);
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
    if (rendered.attachmentText) required.push(PermissionFlagsBits.AttachFiles);
    if (!permissions?.has(required)) {
      this.deps.log.warn("company-pin-sharing: missing delivery permissions");
      return;
    }
    // Recheck lifetime and runtime binding after reads, before claiming the external side effect.
    const current = this.deps.target();
    if (this.deps.isStopped() || current?.guildId !== target.guildId || current.channelId !== target.channelId
      || this.deps.isPrivateOrForeign(source.channelId)) return;
    const key = `company-pin-share:${target.guildId}:${source.channelId}:${source.messageId}`;
    const sending = JSON.stringify({ state: "sending", channelId: target.channelId });
    if (!this.deps.config.compareAndSwap(key, null, sending)) return;
    try {
      const posted = await destination.send({
        content: rendered.content, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds,
        nonce: source.messageId, enforceNonce: true,
        ...(rendered.attachmentText ? { files: [{ attachment: Buffer.from(rendered.attachmentText, "utf8"), name: "pinned-content.txt" }] } : {}),
      });
      this.deps.config.compareAndSwap(key, sending, JSON.stringify({ state: "sent", channelId: target.channelId, messageId: posted.id }));
    } catch {
      // Includes successful Discord delivery followed by a failed local write. Never retry blindly.
      this.deps.config.compareAndSwap(key, sending, JSON.stringify({ state: "unknown", channelId: target.channelId }));
      this.deps.log.warn("company-pin-sharing: delivery outcome unknown; automatic resend disabled");
    }
  }
}
