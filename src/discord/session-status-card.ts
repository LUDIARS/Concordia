import {
  ChannelType,
  EmbedBuilder,
  type AnyThreadChannel,
  type Guild,
  type TextChannel,
} from "discord.js";
import type { DiscordConfigRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { sessionChannelSlug } from "./formatter.js";
import type {
  ChatReadModel,
  DelegatedChildStatus,
  SessionCacheSnapshot,
} from "../platform/chat-read-model.js";
import type { ProjectSufficiency } from "../harness/data-sufficiency.js";
import { formatFastMode, formatWorkingBranch } from "./runtime-metadata.js";

const ACTIVE_WINDOW_SEC = 60;
const WAITING_WINDOW_SEC = 5 * 60;

/** 状態カードを送れる面 (専用チャンネル / セッションの forum thread)。 */
type StatusCardChannel = TextChannel | AnyThreadChannel;

const STATUS_MESSAGE_KEY_PREFIX = "session_status_message_id:";
const STATUS_CHANNEL_KEY_PREFIX = "session_status_channel_id:";
const CONTEXT_WARNING_KEY_PREFIX = "session_context85_notified:";
const CONTEXT_WARNING_THRESHOLD = 0.85;

export function getStatusChannelId(
  configRepo: DiscordConfigRepo,
  sessionId: string,
): string | null {
  const v = configRepo.get(STATUS_CHANNEL_KEY_PREFIX + sessionId);
  return v || null;
}

export interface SessionStatusCardDeps {
  guild: Guild;
  layout: DiscordConfigSnapshot;
  configRepo: DiscordConfigRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  readModel: ChatReadModel;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export interface UpsertStatusCardOptions {
  allowCreate?: boolean;
}

export async function upsertSessionStatusCard(
  deps: SessionStatusCardDeps,
  sessionId: string,
  opts: UpsertStatusCardOptions = {},
): Promise<void> {
  const sessionChannelRow = deps.sessionChannelsRepo.findBySessionId(sessionId);
  if (!sessionChannelRow) return;
  const snapshot = await deps.readModel.getSessionStatusSnapshot(sessionId, sessionChannelRow.channel_id);
  if (!snapshot) return;

  const surface = await ensureStatusSurface(deps, {
    sessionId,
    provider: snapshot.provider,
    roleLabel: snapshot.roleLabel,
    allowCreate: opts.allowCreate ?? false,
    sessionChannelId: sessionChannelRow.channel_id,
  });
  if (!surface) return;
  const statusChannel = surface.channel;

  const embed = buildSessionStatusEmbed(snapshot);
  await maybeNotifyHighContextUsage(deps, {
    sessionId,
    statusChannel,
    contextBadge: snapshot.contextBadge,
    contextPct: snapshot.contextPct,
    requesterUserId: snapshot.contextWarningRequesterUserId,
  });

  const msgKey = `${STATUS_MESSAGE_KEY_PREFIX}${sessionId}`;
  const chKey = `${STATUS_CHANNEL_KEY_PREFIX}${sessionId}`;
  const handleUnknownChannel = () => {
    deps.configRepo.set(msgKey, "");
    deps.configRepo.set(chKey, "");
    deps.guild.channels.cache.delete(statusChannel.id);
    deps.log.info(`status-card: channel gone, cache cleared session=${sessionId} channel=${statusChannel.id}`);
  };

  const messageId = deps.configRepo.get(msgKey);
  if (messageId) {
    try {
      const msg = await statusChannel.messages.fetch(messageId);
      await msg.edit({ content: "", embeds: [embed] });
      return;
    } catch (e) {
      if ((e as { code?: number }).code === 10003) {
        handleUnknownChannel();
        return;
      }
    }
  }

  try {
    // 専用チャンネルのときだけ掃除する。 セッションの投稿 (forum thread) は会話そのものなので、
    // ここで bot 発言を消すと中継ログが消える。
    if (!surface.isSessionThread) await purgeBotMessages(deps, statusChannel);
    const sent = await statusChannel.send({ embeds: [embed] });
    // 投稿に貼る形では会話に流れて見えなくなるため pin して定位置に置く (best-effort)。
    if (surface.isSessionThread) await sent.pin().catch(() => undefined);
    deps.configRepo.set(msgKey, sent.id);
    deps.log.info(`status-card: created session=${sessionId} channel=${statusChannel.id} message=${sent.id}`);
  } catch (e) {
    if ((e as { code?: number }).code === 10003) {
      handleUnknownChannel();
      return;
    }
    deps.configRepo.set(msgKey, "");
    deps.log.warn(`status-card: send failed session=${sessionId} channel=${statusChannel.id}: ${(e as Error).message}`);
  }
}

export interface StatusEmbedInput {
  sessionId: string;
  provider: string;
  model?: string | null;
  effortLevel?: string | null;
  fastMode?: boolean | null;
  branch: string | null;
  repoPath: string;
  targetProject?: string | null;
  currentTask: string | null;
  status: string;
  ageSec: number | null;
  roleLabel: string | null;
  sessionChannelId: string;
  inProgress: Array<{ active_form: string | null; task_text: string }>;
  pending: Array<{ task_text: string }>;
  doneCount: number;
  concordiaPending: number;
  delegatedChildren?: DelegatedChildStatus[];
  cache?: SessionCacheSnapshot | null;
  sufficiency?: ProjectSufficiency | null;
  contextBadge?: string;
  contextPct?: number | null;
  costBadge?: string;
  goalBadge?: string;
}

export interface ContextWarningInput {
  sessionId: string;
  contextBadge: string;
  contextPct: number;
  requesterUserId?: string | null;
}

export function buildContextWarningMessage(i: ContextWarningInput): string {
  const mention = i.requesterUserId ? `<@${i.requesterUserId}> ` : "";
  const pct = Math.round(i.contextPct * 100);
  return `${mention}⚠️ コンテキスト使用量が ${pct}% を超えました (${i.contextBadge})\n` +
    "必要なら `/co-compaction` で引き継ぎ型コンパクションするか、区切りのよいところでセッションを閉じてください。";
}

export function buildSessionStatusEmbed(i: StatusEmbedInput): EmbedBuilder {
  const activity = buildActivityLabel(i.status, i.ageSec);
  const statusValue = activity ? `\`${i.status}\` ${activity}` : `\`${i.status}\``;
  const repoName = i.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? i.repoPath;
  const shortId = i.sessionId.replace(/^lictor-/, "").slice(0, 8);

  const taskLines: string[] = [];
  for (const t of i.inProgress.slice(0, 5)) taskLines.push(`▶ ${truncate(t.active_form || t.task_text, 120)}`);
  for (const t of i.pending.slice(0, 8)) taskLines.push(`⏳ ${truncate(t.task_text, 120)}`);
  const taskValue = taskLines.length > 0 ? taskLines.join("\n").slice(0, 1000) : "_(no open tasks)_";
  const taskHeader =
    `${i.inProgress.length} ▶ / ${i.pending.length} ⏳ / ${i.doneCount} ✓` +
    (i.concordiaPending > 0 ? ` · 依頼残 ${i.concordiaPending}` : "");
  const delegatedChildren = formatDelegatedChildren(i.delegatedChildren ?? []);

  const descParts: string[] = [];
  if (i.currentTask) descParts.push(`**${truncate(i.currentTask, 200)}**`);
  descParts.push(`<#${i.sessionChannelId}>`);
  if (i.goalBadge) descParts.push(i.goalBadge);

  const usageBadges: string[] = [];
  if (i.contextBadge) {
    usageBadges.push(i.contextPct != null && i.contextPct >= 0.75 ? `⚠️ ${i.contextBadge}` : i.contextBadge);
  }
  if (i.costBadge) usageBadges.push(i.costBadge);
  if (usageBadges.length) descParts.push(usageBadges.join(" · "));

  const embed = new EmbedBuilder()
    .setColor(statusColor(i.status, i.ageSec))
    .setTitle((i.roleLabel && i.roleLabel !== "-" ? i.roleLabel : i.provider).slice(0, 250))
    .setDescription(descParts.join("\n"))
    .addFields(
      { name: "状態", value: statusValue, inline: true },
      { name: "Agent", value: `\`${i.provider}\``, inline: true },
      { name: "作業ブランチ", value: formatWorkingBranch(i.branch), inline: true },
      { name: "Model", value: `\`${i.model ?? "-"}\``, inline: true },
      { name: "Effort", value: `\`${i.effortLevel ?? "-"}\``, inline: true },
      { name: "Fast mode", value: formatFastMode(i.fastMode), inline: true },
      { name: "Repo", value: `\`${repoName}\``, inline: true },
      { name: "作業対象", value: `\`${i.targetProject ?? "-"}\``, inline: true },
      { name: `タスク (${taskHeader})`, value: taskValue, inline: false },
    );

  if (delegatedChildren) {
    embed.addFields({
      name: `Delegation children (${i.delegatedChildren?.length ?? 0})`,
      value: delegatedChildren,
      inline: false,
    });
  }

  const cacheLine = formatCacheField(i.cache);
  if (cacheLine) embed.addFields({ name: "Anatomia キャッシュ", value: cacheLine, inline: false });
  const sufficiencyLine = formatSufficiencyField(i.sufficiency);
  if (sufficiencyLine) embed.addFields({ name: "Anatomia/Thaleia 充足", value: sufficiencyLine, inline: false });

  return embed
    .setFooter({ text: `session ${shortId} ﾂｷ ${truncate(i.repoPath, 80)}` })
    .setTimestamp(new Date());
}

function formatDelegatedChildren(children: NonNullable<StatusEmbedInput["delegatedChildren"]>): string | null {
  if (children.length === 0) return null;
  const lines = children.slice(0, 8).map((child) => {
    const run = child.runId.slice(0, 8);
    const claimed = child.childSessionId
      ? ` · child ${child.childSessionId.replace(/^lictor-/, "").slice(0, 8)}`
      : "";
    return `\`${truncate(child.status, 16)}\` ${truncate(child.taskLabel, 120)} · ${truncate(child.callName, 48)} · run ${run}${claimed}`;
  });
  return truncate(lines.join("\n"), 1024);
}

function formatSufficiencyField(sufficiency: ProjectSufficiency | null | undefined): string | null {
  if (!sufficiency) return null;
  const an = sufficiency.anatomia.present
    ? `An ✓ fn=${sufficiency.anatomia.functions ?? 0} dom=${sufficiency.anatomia.domains ?? 0}`
    : "An —";
  const th = sufficiency.thaleia.present
    ? `Th ✓ ${sufficiency.thaleia.implementedSpecs ?? 0}/${sufficiency.thaleia.specs ?? 0} gap=${sufficiency.thaleia.gapCount ?? 0}`
    : "Th —";
  return `\`${sufficiency.project}\` · ${an} · ${th}`;
}

function formatCacheField(cache: SessionCacheSnapshot | null | undefined): string | null {
  if (!cache || cache.gets === 0) return null;
  const pct = `${Math.round(cache.hitRate * 100)}%`;
  const tilde = cache.basis === "assumed" ? "~" : "";
  const usd = (v: number) => `${tilde}$${v.toFixed(v < 0.05 ? 4 : 2)}`;
  return `${pct} hit (${cache.hits}/${cache.gets}) · 節約 ${usd(cache.savedUsd)} · コスト ${usd(cache.spentUsd)}`;
}

function statusColor(status: string, ageSec: number | null): number {
  if (status !== "active") return 0x747f8d;
  if (ageSec !== null && ageSec <= ACTIVE_WINDOW_SEC) return 0x3ba55d;
  if (ageSec !== null && ageSec <= WAITING_WINDOW_SEC) return 0xfaa61a;
  return 0x747f8d;
}

async function purgeBotMessages(deps: SessionStatusCardDeps, channel: StatusCardChannel): Promise<void> {
  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    const selfId = deps.guild.client.user?.id;
    for (const m of msgs.values()) {
      if (selfId && m.author.id !== selfId) continue;
      try { await m.delete(); } catch {}
    }
  } catch (e) {
    if ((e as { code?: number }).code === 10003) throw e;
    deps.log.warn(`status-card: purge failed channel=${channel.id}: ${(e as Error).message}`);
  }
}

async function maybeNotifyHighContextUsage(
  deps: SessionStatusCardDeps,
  input: {
    sessionId: string;
    statusChannel: StatusCardChannel;
    contextBadge: string;
    contextPct: number | null;
    requesterUserId?: string | null;
  },
): Promise<void> {
  const key = `${CONTEXT_WARNING_KEY_PREFIX}${input.sessionId}`;
  if (input.contextPct === null || input.contextPct < CONTEXT_WARNING_THRESHOLD) {
    if (deps.configRepo.get(key)) deps.configRepo.set(key, "");
    return;
  }
  if (deps.configRepo.get(key)) return;
  try {
    await input.statusChannel.send({
      content: buildContextWarningMessage({
        sessionId: input.sessionId,
        contextBadge: input.contextBadge,
        contextPct: input.contextPct,
        requesterUserId: input.requesterUserId ?? null,
      }),
      allowedMentions: input.requesterUserId ? { users: [input.requesterUserId] } : { users: [] },
    });
    deps.configRepo.set(key, String(Date.now()));
  } catch (e) {
    deps.log.warn(`status-card: context warning failed session=${input.sessionId}: ${(e as Error).message}`);
  }
}

/** 状態カードを置く面。 forum 運用ではセッションの投稿そのもの。 */
interface StatusSurface {
  channel: StatusCardChannel;
  /** セッションの forum thread に貼っているか (= 専用チャンネルではない)。 */
  isSessionThread: boolean;
}

/**
 * 状態カードの置き場を決める。
 *
 * forum 運用では**専用チャンネルを作らず**、セッションの投稿 (forum thread) に貼る
 * (2026-08-09 neco 指示: 状態カードのチャンネルは見られていない)。 チャンネル運用の
 * ときだけ従来どおり status カテゴリのチャンネルを使う。
 */
async function ensureStatusSurface(
  deps: SessionStatusCardDeps,
  input: {
    sessionId: string;
    provider: string;
    roleLabel: string | null;
    allowCreate: boolean;
    sessionChannelId: string;
  },
): Promise<StatusSurface | null> {
  if (deps.layout.forumMode) {
    const thread = await resolveSessionThread(deps, input.sessionChannelId);
    if (!thread) return null;
    // 掃除 (reconcileLostStatusCards) が辿れるよう、貼り先は従来と同じキーに記録する。
    deps.configRepo.set(`${STATUS_CHANNEL_KEY_PREFIX}${input.sessionId}`, thread.id);
    return { channel: thread, isSessionThread: true };
  }
  const channel = await ensureStatusChannel(deps, input);
  return channel ? { channel, isSessionThread: false } : null;
}

async function resolveSessionThread(
  deps: SessionStatusCardDeps,
  channelId: string,
): Promise<StatusCardChannel | null> {
  const channel = deps.guild.channels.cache.get(channelId)
    ?? await deps.guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  return channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread
    ? channel
    : null;
}

async function ensureStatusChannel(
  deps: SessionStatusCardDeps,
  input: { sessionId: string; provider: string; roleLabel: string | null; allowCreate: boolean },
): Promise<TextChannel | null> {
  const key = `${STATUS_CHANNEL_KEY_PREFIX}${input.sessionId}`;
  const base = sessionChannelSlug(input.provider, input.roleLabel).slice(0, 80);
  const shortId = input.sessionId.replace(/^lictor-/, "").slice(0, 6);
  const name = `${base}-${shortId}-status`.slice(0, 95);
  const cached = deps.configRepo.get(key);
  if (cached) {
    const ch = deps.guild.channels.cache.get(cached);
    if (ch && ch.type === ChannelType.GuildText && ch.name === name) return ch;
  }
  const existing = deps.guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.parentId === deps.layout.statusCategoryId && c.name === name,
  );
  if (existing && existing.type === ChannelType.GuildText) {
    deps.configRepo.set(key, existing.id);
    return existing;
  }
  if (!input.allowCreate) return null;
  try {
    const created = await deps.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: deps.layout.statusCategoryId,
      topic: `session ${input.sessionId}`,
    });
    deps.configRepo.set(key, created.id);
    return created;
  } catch (e) {
    deps.log.warn(`status-card: create status channel failed session=${input.sessionId}: ${(e as Error).message}`);
    return null;
  }
}

type StatusCardCleanupDeps = {
  guild: Guild;
  configRepo: DiscordConfigRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
};

export async function deleteSessionStatusCard(
  deps: StatusCardCleanupDeps,
  sessionId: string,
): Promise<void> {
  const chKey = `${STATUS_CHANNEL_KEY_PREFIX}${sessionId}`;
  const channelId = deps.configRepo.get(chKey);
  if (channelId) {
    const ch = deps.guild.channels.cache.get(channelId)
      ?? await deps.guild.channels.fetch(channelId).catch(() => null);
    // forum 運用ではセッションの投稿に貼っている。 面ごと消すと会話が消えるので、
    // カードのメッセージだけ取り下げる。
    if (ch?.isThread()) {
      const messageId = deps.configRepo.get(`${STATUS_MESSAGE_KEY_PREFIX}${sessionId}`);
      if (messageId) {
        await ch.messages.delete(messageId).catch(() => undefined);
        deps.log.info(`status-card: removed card message session=${sessionId} thread=${ch.id}`);
      }
      deps.configRepo.set(chKey, "");
      deps.configRepo.set(`${STATUS_MESSAGE_KEY_PREFIX}${sessionId}`, "");
      return;
    }
    if (ch) {
      try {
        await ch.delete(`session ${sessionId} status card removed`);
        deps.log.info(`status-card: deleted channel=${channelId} for ${sessionId}`);
      } catch (e) {
        const isGone = (e as { code?: number }).code === 10003;
        if (isGone) {
          deps.guild.channels.cache.delete(channelId);
          deps.log.info(`status-card: channel already gone session=${sessionId} channel=${channelId}`);
        } else {
          deps.log.warn(`status-card: delete failed session=${sessionId}: ${(e as Error).message}`);
        }
      }
    }
    deps.configRepo.set(chKey, "");
  }
  deps.configRepo.set(`${STATUS_MESSAGE_KEY_PREFIX}${sessionId}`, "");
}

export async function reconcileLostStatusCards(
  deps: StatusCardCleanupDeps & { readModel: ChatReadModel },
): Promise<{ scanned: number; removed: number }> {
  let scanned = 0;
  let removed = 0;
  for (const [key, value] of Object.entries(deps.configRepo.all())) {
    if (!key.startsWith(STATUS_CHANNEL_KEY_PREFIX)) continue;
    if (!value) continue;
    scanned += 1;
    const sessionId = key.slice(STATUS_CHANNEL_KEY_PREFIX.length);
    if (deps.readModel.isSessionActive(sessionId)) continue;
    await deleteSessionStatusCard(deps, sessionId);
    removed += 1;
  }
  return { scanned, removed };
}

function buildActivityLabel(status: string, ageSec: number | null): string {
  if (status !== "active") return "";
  if (ageSec === null) return "⚪ アイドル";
  if (ageSec <= ACTIVE_WINDOW_SEC) return `🟢 作業中 (${ageSec}s ago)`;
  if (ageSec <= WAITING_WINDOW_SEC) return `🟡 待機 (${Math.floor(ageSec / 60)}m ago)`;
  return `⚪ アイドル (${Math.floor(ageSec / 60)}m ago)`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n - 3;
  const before = s.charCodeAt(end - 1);
  const after = s.charCodeAt(end);
  if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
    end -= 1;
  }
  return `${s.slice(0, end)}...`;
}
