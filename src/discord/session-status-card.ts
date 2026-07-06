import { ChannelType, EmbedBuilder, type Guild, type TextChannel } from "discord.js";
import type { DiscordConfigRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { sessionChannelSlug } from "./formatter.js";
import type { ChatReadModel, SessionCacheSnapshot } from "../platform/chat-read-model.js";

const ACTIVE_WINDOW_SEC = 60;
const WAITING_WINDOW_SEC = 5 * 60;

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

  const statusChannel = await ensureStatusChannel(deps, {
    sessionId,
    provider: snapshot.provider,
    roleLabel: roleLabelFromPersonaText(snapshot.personaText),
    personaDisplayName: personaDisplayFromPersonaText(snapshot.personaText),
    allowCreate: opts.allowCreate ?? false,
  });
  if (!statusChannel) return;

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
    await purgeBotMessages(deps, statusChannel);
    const sent = await statusChannel.send({ embeds: [embed] });
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
  branch: string | null;
  repoPath: string;
  currentTask: string | null;
  status: string;
  ageSec: number | null;
  personaText: string;
  sessionChannelId: string;
  inProgress: Array<{ active_form: string | null; task_text: string }>;
  pending: Array<{ task_text: string }>;
  doneCount: number;
  concordiaPending: number;
  cache?: SessionCacheSnapshot | null;
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
    .setTitle((i.personaText && i.personaText !== "-" ? i.personaText : i.provider).slice(0, 250))
    .setDescription(descParts.join("\n"))
    .addFields(
      { name: "状態", value: statusValue, inline: true },
      { name: "Agent", value: `\`${i.provider}\``, inline: true },
      { name: "Branch", value: `\`${i.branch ?? "-"}\``, inline: true },
      { name: "Repo", value: `\`${repoName}\``, inline: true },
      { name: `タスク (${taskHeader})`, value: taskValue, inline: false },
    );

  const cacheLine = formatCacheField(i.cache);
  if (cacheLine) embed.addFields({ name: "Anatomia キャッシュ", value: cacheLine, inline: false });

  return embed
    .setFooter({ text: `session ${shortId} ﾂｷ ${truncate(i.repoPath, 80)}` })
    .setTimestamp(new Date());
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

async function purgeBotMessages(deps: SessionStatusCardDeps, channel: TextChannel): Promise<void> {
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
    statusChannel: TextChannel;
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

async function ensureStatusChannel(
  deps: SessionStatusCardDeps,
  input: { sessionId: string; provider: string; roleLabel: string | null; personaDisplayName: string | null; allowCreate: boolean },
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
      topic: input.personaDisplayName
        ? `${input.personaDisplayName} | session ${input.sessionId}`
        : `session ${input.sessionId}`,
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
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

function roleLabelFromPersonaText(text: string): string | null {
  if (!text || text === "-") return null;
  return text.split(" / ")[0] || null;
}

function personaDisplayFromPersonaText(text: string): string | null {
  if (!text || text === "-") return null;
  return text.split(" / ")[1] || null;
}
