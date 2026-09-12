/** @implements spec/feature/danger-command-approval.md — trusted Discord-only approval */
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, type Client, type Interaction, type Message } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { PushWarningBridge, PushWarningDecision, PushWarningPrompt } from "../platform/push-warning.js";

const PREFIX = "push-warning:";
const TTL_MS = 10 * 60 * 1000;
interface Pending {
  prompt: PushWarningPrompt;
  requester: string;
  channelId: string;
  message: Message | null;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  finish(decision: PushWarningDecision): void;
}
export function createDiscordPushWarning(deps: {
  client: Client;
  sessions: SessionsRepo;
  channels: DiscordSessionChannelsRepo;
  bridge: PushWarningBridge;
  owns(sessionId: string): boolean;
  isAllowed(userId: string): boolean;
  warn(message: string): void;
}): { start(): void; handles(interaction: Interaction): boolean; handle(interaction: Interaction): Promise<void>; stop(): void } {
  const pending = new Map<string, Pending>();
  let stopped = false;
  let unregister: (() => void) | null = null;
  const channelPort = { owns: deps.owns, request: async (prompt: PushWarningPrompt): Promise<PushWarningDecision> => {
    if (stopped || !deps.client.isReady()) return "unavailable";
    if ([...pending.values()].some((entry) => entry.prompt.sessionId === prompt.sessionId)) return "busy";
    const row = deps.channels.findBySessionId(prompt.sessionId);
    const requester = deps.bridge.requester(prompt.sessionId);
    if (!row || row.status !== "active" || requester?.platform !== "discord" || !deps.isAllowed(requester.userId)) return "unavailable";
    const token = randomUUID();
    const answer = new Promise<PushWarningDecision>((resolve) => {
      const finish = (decision: PushWarningDecision): void => {
        const entry = pending.get(token);
        if (!entry) return;
        pending.delete(token);
        clearTimeout(entry.timer);
        resolve(decision);
        if (entry.message) void entry.message.edit({ components: [], content: `WARNING: ${decision}. 承認結果でありpush完了ではありません。` })
          .catch(() => deps.warn("push warning terminal message edit failed"));
      };
      pending.set(token, { prompt, requester: requester.userId, channelId: row.channel_id, message: null,
        expires: Date.now() + TTL_MS, timer: setTimeout(() => finish("denied"), TTL_MS), finish });
    });
    // Delivery must not prevent expiry or stop from resolving a waiting guard.
    void (async () => {
      try {
        const channel = await deps.client.channels.fetch(row.channel_id);
        const entry = pending.get(token);
        if (!entry) return;
        if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Session channel unavailable");
        const message = await channel.send({ content: `<@${requester.userId}> **WARNING: 公開履歴の変更**\n添付の全ref・新旧SHA・送信先を確認してください。許可は今回のpush一回だけです。10分で失効します。AIは自己承認しないでください。`,
          files: [new AttachmentBuilder(Buffer.from(deps.bridge.format(prompt), "utf8"), { name: "push-warning.txt" })],
          allowedMentions: { parse: [], users: [requester.userId] },
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}allow:${token}`).setLabel("全refを確認し、今回だけ許可").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`${PREFIX}deny:${token}`).setLabel("拒否").setStyle(ButtonStyle.Secondary))] });
        if (!pending.has(token)) { await message.edit({ components: [], content: "WARNING: expired / unavailable" }); return; }
        entry.message = message;
        deps.sessions.appendEvent({ session_id: prompt.sessionId, ts: Math.floor(Date.now() / 1000),
          kind: "push_warning_discord_delivered", payload: { token, channel_id: row.channel_id, message_id: message.id } });
      } catch {
        pending.get(token)?.finish("unavailable");
        deps.warn("push warning Discord delivery failed");
      }
    })();
    return answer;
  } };
  return {
    start() { if (!stopped && !unregister) unregister = deps.bridge.register(channelPort); },
    handles: (interaction) => interaction.isButton() && interaction.customId.startsWith(PREFIX),
    async handle(interaction) {
      if (!interaction.isButton()) return;
      const match = /^push-warning:(allow|deny):([a-f0-9-]+)$/.exec(interaction.customId);
      const entry = match ? pending.get(match[2]) : null;
      if (!match || !entry || entry.expires <= Date.now() || entry.message?.id !== interaction.message.id
        || entry.channelId !== interaction.channelId || entry.requester !== interaction.user.id
        || interaction.user.bot || !deps.isAllowed(interaction.user.id) || !deps.owns(entry.prompt.sessionId)
        || deps.channels.findBySessionId(entry.prompt.sessionId)?.channel_id !== entry.channelId
        || deps.channels.findBySessionId(entry.prompt.sessionId)?.status !== "active") {
        await interaction.reply({ content: "期限切れ、対象不一致、または承認権限がありません。", ephemeral: true });
        return;
      }
      // Before the first await: duplicate Gateway events cannot spend approval twice.
      deps.sessions.appendEvent({ session_id: entry.prompt.sessionId, ts: Math.floor(Date.now() / 1000),
        kind: "push_warning_discord_answer", payload: { token: match[2], user_id: interaction.user.id,
          guild_id: interaction.guildId, channel_id: interaction.channelId, message_id: interaction.message.id, decision: match[1] } });
      entry.finish(match[1] === "allow" ? "approved" : "denied");
      await interaction.deferUpdate();
    },
    stop() {
      stopped = true;
      unregister?.();
      unregister = null;
      for (const entry of pending.values()) entry.finish("unavailable");
    },
  };
}
