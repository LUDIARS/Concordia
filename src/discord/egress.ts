import fs from "node:fs";
import path from "node:path";
import type { Guild } from "discord.js";
import type { ChatMessageRelay, ChatReadModel } from "../platform/chat-read-model.js";
import type { DiscordMessageMapRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { ConcordiaEvent } from "../events.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { formatAuthorName } from "./formatter.js";
import { chatChannelToMetaKind, type MetaChannelKind } from "./types.js";
import type { WebhookPool } from "./webhook-pool.js";
import { shouldDropForRelay, stripAskMarkerBlocks } from "../platform/egress-filters.js";
import { buildDelegationMirrorText } from "../delegation/coordination.js";

const DISCORD_ATTACH_MAX_BYTES = 24 * 1024 * 1024; // 24 MiB (Discord 25 MiB limit)

const CODEX_DUP_WINDOW_MS = 90_000;
const codexRelayDedup = new Map<string, number>();
const INACTIVE_TRANSCRIPT_LOG_WINDOW_MS = 30_000;
const inactiveTranscriptLogState = new Map<string, { lastAt: number; suppressed: number }>();
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
  readModel: ChatReadModel;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  messageMap: DiscordMessageMapRepo;
  messageOptimizationEnabled?: boolean;
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
  const row = deps.readModel.getChatMessage(ev.message_id);
  if (!row) {
    deps.log.warn(`egress.handleChatPosted row missing message_id=${ev.message_id}`);
    return;
  }
  // Discord ingress 経由で入った chat は既に元投稿として Discord 側に表示
  // されているので、 ここで再 broadcast すると同じテキストが自分の channel に
  // webhook 名義で再出現する自己ループになる. metadata.source==="discord" は
  // ingress が必ず埋める marker (src/discord/ingress.ts L126).
  const chatMeta = row.metadata;
  if (chatMeta.source === "discord") {
    deps.log.info(
      `egress: chat.posted skipped — source=discord (avoid self-loop) ` +
      `message_id=${row.id} discord_user_id=${chatMeta.discord_user_id ?? "null"}`,
    );
    return;
  }
  const sessionId = row.sessionId;
  const sessionRow = sessionId ? deps.sessionChannelsRepo.findBySessionId(sessionId) : null;
  const session = sessionId ? deps.readModel.getSessionRelayState(sessionId) : null;
  if (!isChatRelayTarget(sessionId, session?.status ?? null, sessionRow?.status ?? null)) {
    deps.log.warn(
      `egress.handleChatPosted skipped unrelayable session message_id=${row.id} row_session_id=${sessionId ?? "null"} ` +
      `session_status=${session?.status ?? "null"} discord_status=${sessionRow?.status ?? "null"} ` +
      `session_channel=${sessionRow?.channel_id ?? "null"}`,
    );
    return;
  }
  const metaKind = mapChannelKind(row.channel, ev.channel);
  const metaChannelId = deps.layout.metaChannels[metaKind] ?? null;
  const forceMeta = row.channel === "chitchat" || row.channel === "consultation" || row.channel === "報告";
  // Lictor が握る送信先を明示してきた場合でも、session-scoped な通常投稿では
  // Concordia が最初に記録した session channel と一致する時だけ採用する。
  const explicitChannelId = chatMeta.discord_channel_id ?? null;
  const trustedExplicitChannelId = trustedDiscordChannelId({
    explicitChannelId,
    sessionId,
    sessionChannelId: sessionRow?.channel_id ?? null,
    forceMeta,
  });
  if (explicitChannelId && trustedExplicitChannelId !== explicitChannelId) {
    deps.log.warn(
      `egress.handleChatPosted ignored discord_channel_id mismatch message_id=${row.id} ` +
      `row_session_id=${sessionId ?? "null"} explicit=${explicitChannelId} ` +
      `session_channel=${sessionRow?.channel_id ?? "null"}`,
    );
  }
  const channelId = trustedExplicitChannelId
    ? trustedExplicitChannelId
    : forceMeta
      ? metaChannelId
      : (sessionRow ? sessionRow.channel_id : metaChannelId);
  deps.log.info(
    `egress.handleChatPosted routing message_id=${row.id} row_session_id=${sessionId ?? "null"} ` +
    `session_channel=${sessionRow?.channel_id ?? "null"} session_status=${sessionRow?.status ?? "null"} ` +
    `meta_kind=${metaKind} meta_channel=${metaChannelId ?? "null"} chosen=${channelId ?? "null"} ` +
    `explicit=${explicitChannelId ?? "null"} trusted_explicit=${trustedExplicitChannelId ?? "null"} ` +
    `policy=${trustedExplicitChannelId ? "explicit" : forceMeta ? "force-meta" : (sessionRow ? "session" : "meta")}`,
  );
  if (!channelId) {
    deps.log.warn(`egress.handleChatPosted no channel resolved message_id=${row.id} row_session_id=${sessionId ?? "null"}`);
    return;
  }
  // 明示 channel 指定時は session webhook ではなく channel webhook を使う。
  // session-scoped 投稿では上で session channel との一致を検証済み。
  const client = trustedExplicitChannelId
    ? await deps.webhooks.getForChannel(channelId)
    : sessionRow && sessionId
      ? await deps.webhooks.getForSession(sessionId)
      : await deps.webhooks.getForChannel(channelId);
  if (!client) {
    deps.log.warn(`egress.handleChatPosted no webhook client message_id=${row.id} channel=${channelId} sessionRow=${sessionRow ? "yes" : "no"}`);
    return;
  }

  const author = resolveAuthor(row);
  const provider = sessionId ? session?.provider ?? null : null;
  if (provider === "codex-cli" && shouldSkipCodexDuplicate(channelId, author, row.text)) {
    dedupStats.skipped_chat_posted += 1;
    deps.log.info(`egress: chat.posted dedup skipped message_id=${row.id} channel=${channelId}`);
    return;
  }
  const attachFiles = buildAttachFiles(chatMeta.attachment_paths, row.id, deps.log);
  const res = await deps.webhooks.send(client, {
    content: row.text,
    username: author,
    ...(attachFiles.length > 0 ? { files: attachFiles } : {}),
  });
  if (res) {
    deps.messageMap.put(res.id, row.id);
    deps.log.info(`egress: chat.posted relayed ok message_id=${row.id} discord_message_id=${res.id} channel=${channelId} attachments=${attachFiles.length}`);
    return;
  }
  deps.log.warn(`egress: chat.posted relay returned empty response message_id=${row.id} channel=${channelId}`);
}

async function handleTranscriptFrame(deps: EgressDeps, ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>): Promise<void> {
  const originalSession = deps.readModel.getSessionRelayState(ev.target_session_id);
  let sessionRow = deps.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  let session = originalSession;
  let relaySessionId = ev.target_session_id;
  let mirroredFromChild = false;
  const directSessionStatus = session?.status ?? null;
  const directDiscordStatus = sessionRow?.status ?? null;
  if (!isActiveRelayTarget(directSessionStatus, directDiscordStatus) && originalSession?.delegationParentSessionId) {
    const parent = deps.readModel.getSessionRelayState(originalSession.delegationParentSessionId);
    const parentRow = deps.sessionChannelsRepo.findBySessionId(originalSession.delegationParentSessionId);
    if (isActiveRelayTarget(parent?.status ?? null, parentRow?.status ?? null)) {
      relaySessionId = originalSession.delegationParentSessionId;
      session = parent;
      sessionRow = parentRow;
      mirroredFromChild = true;
    }
  }
  const sessionStatus = session?.status ?? null;
  const discordStatus = sessionRow?.status ?? null;
  if (!isActiveRelayTarget(sessionStatus, discordStatus)) {
    logInactiveTranscriptFrame(deps, ev, {
      sessionStatus: directSessionStatus,
      discordStatus: directDiscordStatus,
      sessionChannelId: sessionRow?.channel_id ?? null,
    });
    return;
  }
  if (!sessionRow || !session) {
    deps.log.warn(`egress: transcript.frame active check inconsistent session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }

  // Per 2026-05-27 ユーザ指示: only relay "人間向けの最終回答" — concretely:
  //   1) kind=text && role=assistant : AI が user に返す本文
  //   2) kind=summary                 : 会話要約 (PreCompact / wrap 時)
  // When Discord message optimization is enabled, (1) is suppressed for
  // providers that have an alternate optimized message path. Codex carries
  // `phase` in transcript payloads; commentary is suppressed and final_answer
  // remains relayable.
  // Everything else (tool-use / tool-result / thinking / raw / user prompts)
  // is dropped here. User prompts are NOT relayed via transcript.frame because
  // a separate `session.event(kind=prompt)` handler in bot.ts already posts
  // them as "CLI User" — keeping both would duplicate every prompt.
  let role: string | null = null;
  let text: string | null = null;
  let phase: string | null = null;
  if (ev.kind === "text") {
    const p = ev.payload as { role?: string; text?: string; phase?: string } | null | undefined;
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
    phase = typeof p.phase === "string" ? p.phase : null;
  } else if (ev.kind === "summary") {
    const p = ev.payload as { text?: string; summary?: string } | null | undefined;
    const candidate = typeof p?.text === "string" ? p.text : typeof p?.summary === "string" ? p.summary : null;
    if (!candidate) {
      deps.log.info(`egress: transcript.frame skipped empty summary session=${ev.target_session_id} seq=${ev.seq}`);
      return;
    }
    role = "summary";
    text = candidate;
  } else if (ev.kind === "image") {
    const p = ev.payload as { media_type?: string; data?: string } | null | undefined;
    if (!p?.data) {
      deps.log.info(`egress: transcript.frame skipped empty image session=${ev.target_session_id} seq=${ev.seq}`);
      return;
    }
    const client = await deps.webhooks.getForSession(relaySessionId);
    if (!client) {
      deps.log.warn(`egress: transcript.frame image no webhook session=${relaySessionId}`);
      return;
    }
    const author = formatAuthorName(null, session?.roleLabel ?? null);
    const ext = (p.media_type ?? "").includes("png") ? "png" : "jpg";
    const buf = Buffer.from(p.data, "base64");
    const res = await deps.webhooks.send(client, {
      content: "",
      username: author,
      files: [{ attachment: buf, name: `image.${ext}` }],
    });
    if (res) {
      deps.log.info(`egress: transcript.frame image relayed ok session=${relaySessionId} source_session=${ev.target_session_id} seq=${ev.seq}`);
    } else {
      deps.log.warn(`egress: transcript.frame image relay empty session=${ev.target_session_id} seq=${ev.seq}`);
    }
    return;
  } else {
    deps.log.info(
      `egress: transcript.frame skipped non-text session=${ev.target_session_id} seq=${ev.seq} ` +
      `kind=${ev.kind} payload=${previewPayload(ev.payload)}`,
    );
    return;
  }

  if (
    role === "assistant" &&
    deps.messageOptimizationEnabled === true &&
    (session.provider !== "codex-cli" || (phase !== null && phase !== "final_answer"))
  ) {
    deps.log.info(
      `egress: transcript.frame skipped by message optimization ` +
      `session=${ev.target_session_id} seq=${ev.seq} provider=${session.provider} phase=${phase ?? "null"}`,
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

  deps.log.info(
    `egress.handleTranscriptFrame routing target_session_id=${ev.target_session_id} seq=${ev.seq} ` +
    `role=${role} session_channel=${sessionRow.channel_id} session_status=${sessionStatus} ` +
    `discord_status=${sessionRow.status} webhook_id=${sessionRow.webhook_id ?? "null"}`,
  );
  const client = await deps.webhooks.getForSession(relaySessionId);
  if (!client) {
    deps.log.warn(`egress: transcript.frame no webhook client session=${relaySessionId} source_session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }

  const author = mirroredFromChild
    ? "Cc delegation"
    : role === "summary"
      ? "Conversation summary"
      : formatAuthorName(role === "assistant" ? session.personaDisplayName : null, session.roleLabel);
  const content = mirroredFromChild && originalSession?.delegationRunId
    ? buildDelegationMirrorText({
        runId: originalSession.delegationRunId,
        childSessionId: ev.target_session_id,
        text,
      })
    : text;
  if (session?.provider === "codex-cli" && shouldSkipCodexDuplicate(sessionRow.channel_id, author, content)) {
    dedupStats.skipped_transcript_frame += 1;
    deps.log.info(`egress: transcript.frame dedup skipped session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
    return;
  }
  const res = await deps.webhooks.send(client, { content, username: author });
  if (res) {
    deps.log.info(`egress: transcript.frame relayed ok session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
    return;
  }
  deps.log.warn(`egress: transcript.frame relay returned empty response session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
}

function logInactiveTranscriptFrame(
  deps: EgressDeps,
  ev: Extract<ConcordiaEvent, { type: "transcript.frame" }>,
  status: { sessionStatus: string | null; discordStatus: string | null; sessionChannelId: string | null },
): void {
  const now = Date.now();
  const prev = inactiveTranscriptLogState.get(ev.target_session_id);
  if (prev && now - prev.lastAt < INACTIVE_TRANSCRIPT_LOG_WINDOW_MS) {
    prev.suppressed += 1;
    return;
  }
  const suppressed = prev?.suppressed ?? 0;
  inactiveTranscriptLogState.set(ev.target_session_id, { lastAt: now, suppressed: 0 });
  deps.log.warn(
    `egress: transcript.frame skipped inactive session=${ev.target_session_id} seq=${ev.seq} kind=${ev.kind} ` +
    `session_status=${status.sessionStatus ?? "null"} discord_status=${status.discordStatus ?? "null"} ` +
    `session_channel=${status.sessionChannelId ?? "null"} suppressed=${suppressed}`,
  );
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

function mapChannelKind(rowChannel: string, evChannel: string): MetaChannelKind {
  const fromRow = chatChannelToMetaKind(rowChannel as never);
  if (fromRow) return fromRow;
  if (evChannel === "houkoku" || evChannel === "報告") return "houkoku";
  return "system";
}

function resolveAuthor(row: ChatMessageRelay): string {
  return row.authorLabel?.trim() || "Concordia";
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

export function trustedDiscordChannelId(input: {
  explicitChannelId: string | null;
  sessionId: string | null;
  sessionChannelId: string | null;
  forceMeta: boolean;
}): string | null {
  if (!input.explicitChannelId) return null;
  if (!input.sessionId) return null;
  if (input.forceMeta) return input.explicitChannelId;
  if (!input.sessionChannelId) return null;
  return input.explicitChannelId === input.sessionChannelId ? input.explicitChannelId : null;
}

export function isChatRelayTarget(
  sessionId: string | null | undefined,
  sessionStatus: string | null | undefined,
  discordStatus: string | null | undefined,
): boolean {
  return !!sessionId && isActiveRelayTarget(sessionStatus, discordStatus);
}

export function isActiveRelayTarget(
  sessionStatus: string | null | undefined,
  discordStatus: string | null | undefined,
): boolean {
  return sessionStatus === "active" && discordStatus === "active";
}

function buildAttachFiles(
  rawPaths: string[] | undefined,
  messageId: number,
  log: { warn: (m: string) => void },
): Array<{ attachment: Buffer; name: string }> {
  if (!rawPaths?.length) return [];
  const out: Array<{ attachment: Buffer; name: string }> = [];
  for (const p of rawPaths) {
    const absPath = path.isAbsolute(p) ? p : null;
    if (!absPath) {
      log.warn(`egress: attachment skipped (not absolute) message_id=${messageId} path=${p}`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      log.warn(`egress: attachment not found message_id=${messageId} path=${absPath}`);
      continue;
    }
    if (stat.size > DISCORD_ATTACH_MAX_BYTES) {
      log.warn(`egress: attachment too large (${stat.size}B) message_id=${messageId} path=${absPath}`);
      continue;
    }
    try {
      const buf = fs.readFileSync(absPath);
      out.push({ attachment: buf, name: path.basename(absPath) });
    } catch (err) {
      log.warn(`egress: attachment read failed message_id=${messageId} path=${absPath}: ${(err as Error).message}`);
    }
  }
  return out;
}
