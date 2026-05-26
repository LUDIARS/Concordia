// eventBus subscribe → Discord channel に投稿 (webhook 経由).
//
// - chat.posted (meta 4 channel) → 対応する meta Discord channel
// - chat.posted (session_id 指定 + scope=local) → 該当 session channel
// - transcript.frame (kind=text, role=assistant) → session channel
// - chat-mute ON 中は no-op
//
// Webhook 投稿名は persona.display_name で per-message 上書き.
// chat_messages テーブルから text / channel / persona を引き、 chunk して投げる.

import type { Guild } from "discord.js";
import type { ChatMessageRow, ChatRepo } from "../db/chat-repo.js";
import type {
  DiscordMessageMapRepo,
  DiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaEvent } from "../events.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { chunkForDiscord, formatAuthorName } from "./formatter.js";
import { chatChannelToMetaKind, type MetaChannelKind } from "./types.js";
import type { WebhookPool } from "./webhook-pool.js";

export interface EgressDeps {
  guild: Guild;
  layout: DiscordConfigSnapshot;
  webhooks: WebhookPool;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  personasRepo: PersonasRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  messageMap: DiscordMessageMapRepo;
  isChatMuted: () => boolean;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export function handleEvent(deps: EgressDeps, ev: ConcordiaEvent): void {
  if (deps.isChatMuted()) return;
  if (ev.type === "chat.posted") {
    void handleChatPosted(deps, ev);
    return;
  }
  if (ev.type === "transcript.frame") {
    void handleTranscriptFrame(deps, ev);
    return;
  }
}

async function handleChatPosted(
  deps: EgressDeps,
  ev: Extract<ConcordiaEvent, { type: "chat.posted" }>,
): Promise<void> {
  const row = deps.chatRepo.findById(ev.message_id);
  if (!row) return;

  // 投稿先 channel 解決:
  //   1. session_id 指定で session channel が存在 → そこ
  //   2. それ以外は meta channel
  const sessionId = row.session_id;
  const sessionRow = sessionId
    ? deps.sessionChannelsRepo.findBySessionId(sessionId)
    : null;
  const channelId = sessionRow
    ? sessionRow.channel_id
    : (deps.layout.metaChannels[mapChannelKind(row, ev.channel)] ?? null);
  if (!channelId) return;

  // webhook 解決 (session channel か meta channel か)
  const client = sessionRow && sessionId
    ? await deps.webhooks.getForSession(sessionId)
    : await deps.webhooks.getForChannel(channelId);
  if (!client) {
    deps.log.warn(`egress: webhook not available for channel ${channelId}`);
    return;
  }

  const author = resolveAuthor(deps, row);
  const chunks = chunkForDiscord(row.text);
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i]!;
    const res = await deps.webhooks.send(client, {
      content: part,
      username: author,
      // avatarURL: 将来 persona.discord_avatar_url から
    });
    if (res && i === 0) deps.messageMap.put(res.id, row.id);
  }
}

async function handleTranscriptFrame(
  deps: EgressDeps,
  ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>,
): Promise<void> {
  if (ev.kind !== "text") return;
  const p = ev.payload as { role?: string; text?: string } | null | undefined;
  if (!p || p.role !== "assistant" || !p.text) return;

  const sessionRow = deps.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  if (!sessionRow || sessionRow.status === "ended") return;

  const client = await deps.webhooks.getForSession(ev.target_session_id);
  if (!client) return;

  const session = deps.sessionsRepo.findSession(ev.target_session_id);
  const meta = readMeta(session?.metadata);
  const role = meta.role_label ?? null;
  const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
  const author = formatAuthorName(persona?.display_name ?? null, role);
  const chunks = chunkForDiscord(p.text);
  for (const part of chunks) {
    await deps.webhooks.send(client, {
      content: part,
      username: author,
    });
  }
}

function mapChannelKind(row: ChatMessageRow, evChannel: string): MetaChannelKind {
  const fromRow = chatChannelToMetaKind(row.channel);
  if (fromRow) return fromRow;
  // chat_messages の channel が `'報告'` 等で fromRow が null になるケースは無いが、
  // ev.channel を fallback で見る (将来 channel 追加に備える)
  if (evChannel === "houkoku" || evChannel === "報告") return "houkoku";
  return "system";
}

function resolveAuthor(deps: EgressDeps, row: ChatMessageRow): string {
  // chat_messages.author_label は dispatcher / API が persona.display_name + role を
  // 詰めているので、 そのまま使うのが基本. ただし空文字なら 'Concordia' fallback.
  return row.author_label?.trim() || "Concordia";
}

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
}
