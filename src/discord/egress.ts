import type { Guild } from "discord.js";
import type { ChatMessageRow, ChatRepo } from "../db/chat-repo.js";
import type { DiscordMessageMapRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaEvent } from "../events.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { formatAuthorName } from "./formatter.js";
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
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export function handleEvent(deps: EgressDeps, ev: ConcordiaEvent): void {
  if (ev.type === "chat.posted") {
    void handleChatPosted(deps, ev).catch((err) => {
      deps.log.warn(`egress: chat.posted dispatch failed message_id=${ev.message_id}: ${(err as Error).message}`);
    });
    return;
  }
  if (ev.type === "transcript.frame") {
    void handleTranscriptFrame(deps, ev).catch((err) => {
      deps.log.warn(`egress: transcript.frame dispatch failed session=${ev.target_session_id} seq=${ev.seq}: ${(err as Error).message}`);
    });
  }
}

async function handleChatPosted(deps: EgressDeps, ev: Extract<ConcordiaEvent, { type: "chat.posted" }>): Promise<void> {
  deps.log.info(
    `[verbose-cs-bug] egress.handleChatPosted entry message_id=${ev.message_id} ev_session_id=${ev.session_id ?? "null"} ev_channel=${ev.channel} ev_author=${ev.author_label}`,
  );
  const row = deps.chatRepo.findById(ev.message_id);
  if (!row) {
    deps.log.warn(`[verbose-cs-bug] egress.handleChatPosted row missing message_id=${ev.message_id}`);
    return;
  }
  // Discord ingress 経由で入った chat は既に元投稿として Discord 側に表示
  // されているので、 ここで再 broadcast すると同じテキストが自分の channel に
  // webhook 名義で再出現する自己ループになる. metadata.source==="discord" は
  // ingress が必ず埋める marker (src/discord/ingress.ts L126).
  const chatMeta = readChatMeta(row.metadata);
  if (chatMeta.source === "discord") {
    deps.log.info(
      `egress: chat.posted skipped — source=discord (avoid self-loop) ` +
      `message_id=${row.id} discord_user_id=${chatMeta.discord_user_id ?? "null"}`,
    );
    return;
  }
  const sessionId = row.session_id;
  const sessionRow = sessionId ? deps.sessionChannelsRepo.findBySessionId(sessionId) : null;
  const metaKind = mapChannelKind(row, ev.channel);
  const metaChannelId = deps.layout.metaChannels[metaKind] ?? null;
  const forceMeta = row.channel === "chitchat" || row.channel === "consultation" || row.channel === "報告";
  const channelId = forceMeta
    ? metaChannelId
    : (sessionRow ? sessionRow.channel_id : metaChannelId);
  deps.log.info(
    `[verbose-cs-bug] egress.handleChatPosted routing message_id=${row.id} row_session_id=${sessionId ?? "null"} ` +
    `session_channel=${sessionRow?.channel_id ?? "null"} session_status=${sessionRow?.status ?? "null"} ` +
    `meta_kind=${metaKind} meta_channel=${metaChannelId ?? "null"} chosen=${channelId ?? "null"} ` +
    `policy=${forceMeta ? "force-meta" : (sessionRow ? "session" : "meta")}`,
  );
  if (!channelId) {
    deps.log.warn(`[verbose-cs-bug] egress.handleChatPosted no channel resolved message_id=${row.id} row_session_id=${sessionId ?? "null"}`);
    return;
  }
  const client = sessionRow && sessionId
    ? await deps.webhooks.getForSession(sessionId)
    : await deps.webhooks.getForChannel(channelId);
  if (!client) {
    deps.log.warn(`[verbose-cs-bug] egress.handleChatPosted no webhook client message_id=${row.id} channel=${channelId} sessionRow=${sessionRow ? "yes" : "no"}`);
    return;
  }

  const author = resolveAuthor(deps, row);
  const text = row.text.length > 1900 ? `${row.text.slice(0, 1900)}...` : row.text;
  const res = await deps.webhooks.send(client, { content: text, username: author });
  if (res) {
    deps.messageMap.put(res.id, row.id);
    deps.log.info(`egress: chat.posted relayed ok message_id=${row.id} discord_message_id=${res.id} channel=${channelId}`);
    return;
  }
  deps.log.warn(`egress: chat.posted relay returned empty response message_id=${row.id} channel=${channelId}`);
}

async function handleTranscriptFrame(deps: EgressDeps, ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): Promise<void> {
  if (ev.kind !== "text") {
    deps.log.info(
      `egress: transcript.frame skipped non-text session=${ev.target_session_id} seq=${ev.seq} ` +
      `kind=${ev.kind} payload=${previewPayload(ev.payload)}`,
    );
    return;
  }
  const p = ev.payload as { role?: string; text?: string } | null | undefined;
  if (!p || !p.text) {
    deps.log.info(`egress: transcript.frame skipped empty payload session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }
  if (p.role !== "assistant" && p.role !== "user") {
    deps.log.info(`egress: transcript.frame skipped role=${String(p.role)} session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }

  const sessionRow = deps.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  deps.log.info(
    `[verbose-cs-bug] egress.handleTranscriptFrame routing target_session_id=${ev.target_session_id} seq=${ev.seq} ` +
    `role=${p.role} session_channel=${sessionRow?.channel_id ?? "null"} session_status=${sessionRow?.status ?? "null"} ` +
    `webhook_id=${sessionRow?.webhook_id ?? "null"}`,
  );
  if (!sessionRow) {
    deps.log.warn(`egress: transcript.frame no session-channel mapping session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }
  if (sessionRow.status === "ended") {
    deps.log.info(`egress: transcript.frame skipped ended session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }
  const client = await deps.webhooks.getForSession(ev.target_session_id);
  if (!client) {
    deps.log.warn(`egress: transcript.frame no webhook client session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }

  const session = deps.sessionsRepo.findSession(ev.target_session_id);
  const meta = readMeta(session?.metadata);
  const roleLabel = p.role === "user" ? "User" : (meta.role_label ?? null);
  const persona = p.role === "assistant" && meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
  const author = p.role === "user"
    ? "CLI User"
    : formatAuthorName(persona?.display_name ?? null, roleLabel);
  const text = p.text.length > 1900 ? `${p.text.slice(0, 1900)}...` : p.text;
  const res = await deps.webhooks.send(client, { content: text, username: author });
  if (res) {
    deps.log.info(`egress: transcript.frame relayed ok session=${ev.target_session_id} seq=${ev.seq} role=${p.role}`);
    return;
  }
  deps.log.warn(`egress: transcript.frame relay returned empty response session=${ev.target_session_id} seq=${ev.seq} role=${p.role}`);
}

function previewPayload(payload: unknown): string {
  try {
    const raw = JSON.stringify(payload);
    if (!raw) return "null";
    const limit = Number(process.env.CONCORDIA_DISCORD_TRANSCRIPT_LOG_MAX ?? "1200");
    const max = Number.isFinite(limit) && limit > 0 ? limit : 1200;
    return raw.length > max ? `${raw.slice(0, max)}...` : raw;
  } catch {
    return "[unserializable]";
  }
}

function mapChannelKind(row: ChatMessageRow, evChannel: string): MetaChannelKind {
  const fromRow = chatChannelToMetaKind(row.channel);
  if (fromRow) return fromRow;
  if (evChannel === "houkoku" || evChannel === "報告") return "houkoku";
  return "system";
}

function resolveAuthor(_: EgressDeps, row: ChatMessageRow): string {
  return row.author_label?.trim() || "Concordia";
}

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
}

/**
 * chat_messages.metadata の parse helper.
 * Discord ingress が埋める `{source: "discord", discord_user_id, discord_message_id}`
 * を読み、 egress 側で自己ループを検知するために使う.
 */
export function readChatMeta(s: string | null | undefined): {
  source?: string;
  discord_user_id?: string;
  discord_message_id?: string;
  scope?: string;
} {
  if (!s) return {};
  try {
    return JSON.parse(s) as {
      source?: string;
      discord_user_id?: string;
      discord_message_id?: string;
      scope?: string;
    };
  } catch {
    return {};
  }
}
