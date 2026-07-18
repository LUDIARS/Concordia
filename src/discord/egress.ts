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
import { extractRelayableTextFrame } from "../platform/transcript-relay.js";
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
  log: { warn: (m: string) => void };
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
  if (chatMeta.source === "discord") return;
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
  if (!channelId) {
    deps.log.warn(`egress.handleChatPosted no channel resolved message_id=${row.id} row_session_id=${sessionId ?? "null"}`);
    return;
  }
  // Forum thread は親 forum の共有 webhook + thread_id が必要なので、明示指定でも
  // session surface と一致する場合は session 経路を使う。meta の明示指定だけ channel 経路。
  const isSessionSurface = !!sessionRow && !!sessionId && channelId === sessionRow.channel_id;
  const client = isSessionSurface
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
    return;
  }
  const attachFiles = await buildAttachFiles(chatMeta.attachment_paths, row.id, deps.log);
  const res = await deps.webhooks.send(client, {
    content: row.text,
    username: author,
    ...(attachFiles.length > 0 ? { files: attachFiles } : {}),
  });
  if (res) {
    deps.messageMap.put(res.id, row.id);
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

  // Per 2026-05-27 ユーザ指示 (2026-07-18 neco 指示で範囲を縮小): relay
  // "人間向けの回答" — concretely:
  //   1) kind=text && role=assistant : AI が user に返す本文。 message optimization
  //      が OFF (既定) のときは Codex の commentary phase も含め作業中メッセージを
  //      全て中継する (中間進捗を Discord で見えるようにする)。 optimization が ON の
  //      ときだけ「人間向けの最終回答のみ」に絞る (Codex は phase=final_answer のみ、
  //      他 provider は代替の最適化済み経路に任せて生 text frame を出さない)。
  //   2) kind=summary                 : 会話要約 (PreCompact / wrap 時)
  // Everything else (tool-use / tool-result / thinking / raw / user prompts)
  // is dropped here. User prompts are NOT relayed via transcript.frame because
  // a separate `session.event(kind=prompt)` handler in bot.ts already posts
  // them as "CLI User" — keeping both would duplicate every prompt.
  let role: string | null = null;
  let text: string | null = null;
  if (ev.kind === "text") {
    const p = ev.payload as { role?: string; text?: string; phase?: string } | null | undefined;
    if (!p || typeof p.text !== "string" || !p.text) return;
    if (p.role !== "assistant") return;
    role = "assistant";
    text = p.text;
  } else if (ev.kind === "summary") {
    const p = ev.payload as { text?: string; summary?: string } | null | undefined;
    const candidate = typeof p?.text === "string" ? p.text : typeof p?.summary === "string" ? p.summary : null;
    if (!candidate) return;
    role = "summary";
    text = candidate;
  } else if (ev.kind === "image") {
    const p = ev.payload as { media_type?: string; data?: string } | null | undefined;
    if (!p?.data) return;
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
    if (!res) {
      deps.log.warn(`egress: transcript.frame image relay empty session=${ev.target_session_id} seq=${ev.seq}`);
    }
    return;
  } else {
    return;
  }

  const relayable = extractRelayableTextFrame(ev.kind, ev.payload, {
    messageOptimizationEnabled: deps.messageOptimizationEnabled,
    provider: session.provider,
  });
  if (!relayable) return;
  role = relayable.role;
  text = relayable.text;

  const client = await deps.webhooks.getForSession(relaySessionId);
  if (!client) {
    deps.log.warn(`egress: transcript.frame no webhook client session=${relaySessionId} source_session=${ev.target_session_id} seq=${ev.seq}`);
    return;
  }

  const author = mirroredFromChild
    ? "Cc delegation"
    : role === "summary"
      ? "Conversation summary"
      : formatAuthorName(null, session.roleLabel);
  const content = mirroredFromChild && originalSession?.delegationRunId
    ? buildDelegationMirrorText({
        runId: originalSession.delegationRunId,
        childSessionId: ev.target_session_id,
        text,
      })
    : text;
  if (session?.provider === "codex-cli" && shouldSkipCodexDuplicate(sessionRow.channel_id, author, content)) {
    dedupStats.skipped_transcript_frame += 1;
    return;
  }
  const res = await deps.webhooks.send(client, { content, username: author });
  if (!res) deps.log.warn(`egress: transcript.frame relay returned empty response session=${ev.target_session_id} seq=${ev.seq} role=${role}`);
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

async function buildAttachFiles(
  rawPaths: string[] | undefined,
  messageId: number,
  log: { warn: (m: string) => void },
): Promise<Array<{ attachment: Buffer; name: string }>> {
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
      stat = await fs.promises.stat(absPath);
    } catch {
      log.warn(`egress: attachment not found message_id=${messageId} path=${absPath}`);
      continue;
    }
    if (stat.size > DISCORD_ATTACH_MAX_BYTES) {
      log.warn(`egress: attachment too large (${stat.size}B) message_id=${messageId} path=${absPath}`);
      continue;
    }
    try {
      const buf = await fs.promises.readFile(absPath);
      out.push({ attachment: buf, name: path.basename(absPath) });
    } catch (err) {
      log.warn(`egress: attachment read failed message_id=${messageId} path=${absPath}: ${(err as Error).message}`);
    }
  }
  return out;
}
