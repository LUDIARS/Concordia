/**
 * Discord の依頼窓口 (Cc v5、実装メモ 9 / 12)。旧「雑務窓口」チャンネル (chores_channel_id) を「依頼窓口」へ改名して
 * ID・履歴を引き継ぎ、投稿 1 件を依頼 1 件として受け付ける。依頼ごとに投稿からスレッドを作り、
 * 受付・起動 (セッションへのリンク)・カードの開閉・終了・催促だけを出す。受付は Web と同じ use case (CC-V5-INV-07)。
 * カードの管理面は Discord に作らない (管理は Web、実装メモ 12)。
 *
 * @implements spec/feature/request-desk.md — Discord
 */
import { ChannelType, type Guild, type Message, type TextChannel, type ThreadChannel } from "discord.js";
import type { CardChange } from "../control-cards/card-sync.js";
import type { ReminderDelivery } from "../control-cards/reminder-runner.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { discordRequestKey, parseDeskMessage, type DeskRequest } from "../desk/desk-request-policy.js";
import type { DeskDiscordPort } from "../desk/discord-port.js";
import { acceptedNotice, cardNotice, DESK_CHANNEL_NAME, DESK_CHANNEL_TOPIC, deskThreadName, stateNotice } from "./desk-notices.js";

export type { DeskDiscordPort } from "../desk/discord-port.js";

export interface DeskDiscord {
  handlesMessage(message: Message): boolean;
  message(message: Message): Promise<void>;
  stop(): void;
}

const NONE = { parse: [] as [] };

export async function startDeskDiscord(input: {
  guild: Guild;
  config: DiscordConfigRepo;
  port: DeskDiscordPort;
  allowed?: (userId: string) => boolean;
  log: { warn(message: string): void };
}): Promise<DeskDiscord> {
  const { guild, config, port } = input;
  const saved = config.get("chores_channel_id");
  const existing = saved ? guild.channels.cache.get(saved) ?? await guild.channels.fetch(saved).catch(() => null)
    : [...guild.channels.cache.values()].find((c) => c.type === ChannelType.GuildText && [DESK_CHANNEL_NAME, "雑務窓口", "雑務"].includes(c.name));
  // 依頼窓口は本社 guild のトップレベル (カテゴリ外) のテキストチャンネル。
  const channel: TextChannel = existing?.type === ChannelType.GuildText ? existing
    : await guild.channels.create({ name: DESK_CHANNEL_NAME, type: ChannelType.GuildText, topic: DESK_CHANNEL_TOPIC });
  if (channel.name !== DESK_CHANNEL_NAME) await channel.setName(DESK_CHANNEL_NAME);
  if (channel.topic !== DESK_CHANNEL_TOPIC) await channel.setTopic(DESK_CHANNEL_TOPIC).catch(() => undefined);
  if (channel.parentId) await channel.setParent(null, { reason: "request desk is a top-level channel" });
  config.set("chores_channel_id", channel.id);
  let stopped = false;

  const threadOf = async (request: DeskRequest | null): Promise<ThreadChannel | null> => {
    if (!request?.discord_thread_id) return null;
    const found = await guild.channels.fetch(request.discord_thread_id).catch(() => null);
    return found?.isThread() && found.guildId === guild.id ? found : null;
  };

  /** 同じ知らせを 2 度出さない。結果不明の投稿は繰り返さない (pending のまま残す)。 */
  const postOnce = async (key: string, thread: ThreadChannel | null, content: string, mentionUserId: string | null = null): Promise<boolean> => {
    if (!thread || stopped || !config.compareAndSwap(key, null, "pending")) return false;
    await thread.send({
      content: mentionUserId ? `<@${mentionUserId}>\n${content}` : content,
      allowedMentions: mentionUserId ? { parse: [], users: [mentionUserId] } : NONE,
    });
    config.compareAndSwap(key, "pending", "done");
    return true;
  };

  const onRequest = (request: DeskRequest) => {
    const text = stateNotice(request, request.session_id ? port.sessionLinks(request.session_id) : null);
    if (!text) return;
    const event = request.routing_enabled
      ? [request.state, request.routing_issue, request.session_id, request.spawn_id].join(":")
      : request.state;
    void threadOf(request).then((thread) => postOnce(`desk_notice:${request.id}:${event}`, thread, text))
      .catch((error) => input.log.warn(`desk notice failed request=${request.id}: ${String(error)}`));
  };
  const onCard = (change: CardChange) => {
    const fromDesk = change.card.source_kind === "desk-project-selection" || change.card.source_kind === "desk-routing-issue";
    const request = fromDesk && change.card.source_key.startsWith("desk:") ? port.get(change.card.source_key.slice("desk:".length))
      : change.card.session_id ? port.findBySession(change.card.session_id) : null;
    if (!request) return;
    const stamp = change.kind === "opened" ? change.card.updated_at : change.card.closed_at;
    void threadOf(request).then((thread) => postOnce(`desk_card:${change.card.id}:${change.kind}:${stamp}`, thread, cardNotice(change.kind, change.card)))
      .catch((error) => input.log.warn(`desk card notice failed card=${change.card.id}: ${String(error)}`));
  };
  const reminder: ReminderDelivery["deliver"] = async ({ card, text, mentionUserId }) => {
    const request = card.session_id ? port.findBySession(card.session_id) : null;
    const thread = await threadOf(request);
    if (!thread || stopped) return null;
    await thread.send({ content: mentionUserId ? `<@${mentionUserId}>\n${text}` : text,
      allowedMentions: mentionUserId ? { parse: [], users: [mentionUserId] } : NONE });
    return `desk-thread:${thread.id}`;
  };
  port.attachRequestListener(onRequest);
  port.attachCardListener(onCard);
  port.attachReminder(reminder);

  const handlesMessage = (message: Message): boolean => message.guildId === guild.id && message.channelId === channel.id && !message.channel.isThread();

  return {
    handlesMessage,
    async message(message) {
      if (stopped || !handlesMessage(message) || message.author.bot || message.webhookId) return;
      if (input.allowed?.(message.author.id) !== true) {
        await message.reply({ content: "依頼にはセッション起動権限が必要です。", allowedMentions: NONE });
        return;
      }
      const parsed = parseDeskMessage(message.content);
      const key = discordRequestKey(guild.id, message.id);
      if (!parsed.body || !key) return;
      const outcome = port.submit({ requestKey: key, requester: message.author.id, provider: parsed.provider, body: parsed.body });
      if (outcome.kind === "disabled") { await message.reply({ content: "依頼窓口は停止中です (設定 desk.enabled)。", allowedMentions: NONE }); return; }
      if (outcome.kind === "invalid") { await message.reply({ content: `依頼を受け付けられません: ${outcome.problem}`, allowedMentions: NONE }); return; }
      if (outcome.kind === "conflict") return;
      let request = outcome.request;
      if (!request.discord_thread_id && config.compareAndSwap(`desk_thread:${request.id}`, null, "pending")) {
        const thread = await message.startThread({ name: deskThreadName(request), autoArchiveDuration: 10080 });
        port.attachThread(request.id, thread.id);
        config.compareAndSwap(`desk_thread:${request.id}`, "pending", "done");
        request = port.get(request.id) ?? request;
      }
      await postOnce(`desk_notice:${request.id}:accepted`, await threadOf(request), acceptedNotice(request, port.webUrl(`/desk?request=${request.id}`)));
      // スレッドより先に状態が進んでいたら、その知らせもここで出す。
      onRequest(request);
    },
    stop() {
      stopped = true;
      port.attachRequestListener(null);
      port.attachCardListener(null);
      port.attachReminder(null);
    },
  };
}
