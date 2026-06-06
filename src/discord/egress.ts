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
import { shouldDropForRelay, stripAskMarkerBlocks } from "./egress-filters.js";

const CODEX_DUP_WINDOW_MS = 90_000;
const codexRelayDedup = new Map<string, number>();
const dedupStats = {
  skipped_chat_posted: 0,
  skipped_transcript_frame: 0,
};

export function getEgressDedupStats(): { skipped_chat_posted: number; skipped_transcript_frame: number; total: number } {
  return {
    skipped_chat_posted: dedupStats.skipped_chat_posted,
    skipped_transcript_frame: dedupStats.skipped_transcript_frame,
    total: dedupStats.skipped_chat_posted + dedupStats.skipped_transcript_frame,
  };
}

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
    `egress.handleChatPosted entry message_id=${ev.message_id} ev_session_id=${ev.session_id ?? "null"} ev_channel=${ev.channel} ev_author=${ev.author_label}`,
  );
  const row = deps.chatRepo.findById(ev.message_id);
  if (!row) {
    deps.log.warn(`egress.handleChatPosted row missing message_id=${ev.message_id}`);
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
  // Lictor が握る送信先を明示してきた場合は最優先 (spec/discord-lictor-relay.md §4.3)。
  // session→channel の DB ルックアップを routing の権威から外し、 返信混線を断つ。
  const explicitChannelId = chatMeta.discord_channel_id ?? null;
  const channelId = explicitChannelId
    ? explicitChannelId
    : forceMeta
      ? metaChannelId
      : (sessionRow ? sessionRow.channel_id : metaChannelId);
  deps.log.info(
    `egress.handleChatPosted routing message_id=${row.id} row_session_id=${sessionId ?? "null"} ` +
    `session_channel=${sessionRow?.channel_id ?? "null"} session_status=${sessionRow?.status ?? "null"} ` +
    `meta_kind=${metaKind} meta_channel=${metaChannelId ?? "null"} chosen=${channelId ?? "null"} ` +
    `explicit=${explicitChannelId ?? "null"} ` +
    `policy=${explicitChannelId ? "explicit" : forceMeta ? "force-meta" : (sessionRow ? "session" : "meta")}`,
  );
  if (!channelId) {
    deps.log.warn(`egress.handleChatPosted no channel resolved message_id=${row.id} row_session_id=${sessionId ?? "null"}`);
    return;
  }
  // 明示 channel 指定時は session webhook ではなく channel webhook を使う
  // (明示先が session channel と異なりうるため)。
  const client = explicitChannelId
    ? await deps.webhooks.getForChannel(channelId)
    : sessionRow && sessionId
      ? await deps.webhooks.getForSession(sessionId)
      : await deps.webhooks.getForChannel(channelId);
  if (!client) {
    deps.log.warn(`egress.handleChatPosted no webhook client message_id=${row.id} channel=${channelId} sessionRow=${sessionRow ? "yes" : "no"}`);
    return;
  }

  const author = resolveAuthor(deps, row);
  const provider = sessionId ? deps.sessionsRepo.findSession(sessionId)?.provider ?? null : null;
  if (provider === "codex-cli" && shouldSkipCodexDuplicate(channelId, author, row.text)) {
    dedupStats.skipped_chat_posted += 1;
    deps.log.info(`egress: chat.posted dedup skipped message_id=${row.id} channel=${channelId}`);
    return;
  }
  const res = await deps.webhooks.send(client, { content: row.text, username: author });
  if (res) {
    deps.messageMap.put(res.id, row.id);
    deps.log.info(`egress: chat.posted relayed ok message_id=${row.id} discord_message_id=${res.id} channel=${channelId}`);
    return;
  }
  deps.log.warn(`egress: chat.posted relay returned empty response message_id=${row.id} channel=${channelId}`);
}

async function handleTranscriptFrame(deps: EgressDeps, ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): Promise<void> {
  // Per 2026-05-27 ユーザ指示: only relay "人間向けの最終回答" — concretely:
  //   1) kind=text && role=assistant : AI が user に返す本文
  //   2) kind=summary                 : 会話要約 (PreCompact / wrap 時)
  // Everything else (tool-use / tool-result / thinking / raw / user prompts)
  // is dropped here. User prompts are NOT relayed via transcript.frame because
  // a separate `session.event(kind=prompt)` handler in bot.ts already posts
  // them as "CLI User" — keeping both would duplicate every prompt.
  let role: string | null = null;
  let text: string | null = null;
  if (ev.kind === "text") {
    const p = ev.payload as { role?: string; text?: string } | null | undefined;
    if (!p || typeof p.text !== "string" || !p.text) {
      deps.log.info(`egress: transcript.frame skipped empty payload session=${ev.target_session_id} seq=${ev.seq}`);
      return;
    }
    if (p.role !== "assistant") {
      deps.log.info(`egress: transcript.frame skipped role=${String(p.role)} session=${ev.target_session_id} seq=${ev.seq}`);
      return;
    }
    role = "assistant";
    text = p.text;
  } else if (ev.kind === "summary") {
    const p = ev.payload as { text?: string; summary?: string } | null | undefined;
    const candidate = typeof p?.text === "string" ? p.text : typeof p?.summary === "string" ? p.summary : null;
    if (!candidate) {
      deps.log.info(`egress: transcript.frame skipped empty summary session=${ev.target_session_id} seq=${ev.seq}`);
      return;
    }
    role = "summary";
    text = candidate;
  } else {
    deps.log.info(
      `egress: transcript.frame skipped non-text session=${ev.target_session_id} seq=${ev.seq} ` +
      `kind=${ev.kind} payload=${previewPayload(ev.payload)}`,
    );
    return;
  }

  // Lictor の ask マーカー (```ask + JSON) は質問カードとして別途投稿される。
  // 生 JSON ブロックを本文から除去し、 残りが空なら frame ごと relay しない。
  if (role === "assistant") {
    const stripped = stripAskMarkerBlocks(text);
    if (stripped !== text) {
      if (!stripped) {
        deps.log.info(`egress: transcript.frame dropped ask-marker-only session=${ev.target_session_id} seq=${ev.seq}`);
        return;
      }
      text = stripped;
    }
  }

  // text/summary 本文ベースの drop ルール (egress-filters.ts). Codex の
  // guardian JSON 等、 人間向けでないペイロードを除外する。
  if (shouldDropForRelay(text)) {
    deps.log.info(`egress: transcript.frame dropped by content filter session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
    return;
  }

  const sessionRow = deps.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  deps.log.info(
    `egress.handleTranscriptFrame routing target_session_id=${ev.target_session_id} seq=${ev.seq} ` +
    `role=${role} session_channel=${sessionRow?.channel_id ?? "null"} session_status=${sessionRow?.status ?? "null"} ` +
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
  const persona = role === "assistant" && meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
  const author = role === "summary"
    ? "Conversation summary"
    : formatAuthorName(persona?.display_name ?? null, meta.role_label ?? null);
  if (session?.provider === "codex-cli" && shouldSkipCodexDuplicate(sessionRow.channel_id, author, text)) {
    dedupStats.skipped_transcript_frame += 1;
    deps.log.info(`egress: transcript.frame dedup skipped session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
    return;
  }
  const res = await deps.webhooks.send(client, { content: text, username: author });
  if (res) {
    deps.log.info(`egress: transcript.frame relayed ok session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
    return;
  }
  deps.log.warn(`egress: transcript.frame relay returned empty response session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
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

function shouldSkipCodexDuplicate(channelId: string, author: string, text: string): boolean {
  const now = Date.now();
  const key = `${channelId}|${author}|${normalizeDedupText(text)}`;
  const last = codexRelayDedup.get(key);
  codexRelayDedup.set(key, now);
  if (codexRelayDedup.size > 5000) {
    for (const [k, at] of codexRelayDedup) {
      if (now - at > CODEX_DUP_WINDOW_MS) codexRelayDedup.delete(k);
    }
  }
  return !!last && now - last <= CODEX_DUP_WINDOW_MS;
}

function normalizeDedupText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
  /** Lictor が握る送信先 channel ID (spec/discord-lictor-relay.md §4.3)。 */
  discord_channel_id?: string;
} {
  if (!s) return {};
  try {
    return JSON.parse(s) as {
      source?: string;
      discord_user_id?: string;
      discord_message_id?: string;
      scope?: string;
      discord_channel_id?: string;
    };
  } catch {
    return {};
  }
}
