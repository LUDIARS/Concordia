import { ChannelType, EmbedBuilder, type Guild, type TextChannel } from "discord.js";
import type { DiscordConfigRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { sessionChannelSlug } from "./formatter.js";

/** 「直近のセッション活動」 と判定する閾値 (秒). recentEvents の最新 ts と現在時刻の差で見る. */
const ACTIVE_WINDOW_SEC = 60;
/** 「待機」 と判定する閾値 (秒). これを超えるとアイドル扱い. */
const WAITING_WINDOW_SEC = 5 * 60;

const STATUS_MESSAGE_KEY_PREFIX = "session_status_message_id:";
const STATUS_CHANNEL_KEY_PREFIX = "session_status_channel_id:";

/** configRepo に保存済みの状態カードチャンネル ID を返す。未作成なら null。 */
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
  sessionsRepo: SessionsRepo;
  personasRepo: PersonasRepo;
  sessionTaskRecordsRepo: SessionTaskRecordsRepo;
  tasksRepo: TasksRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

export interface UpsertStatusCardOptions {
  /**
   * 状態チャンネルが無いとき新規作成してよいか。
   * 作成は spawn (session.started) 時のみ true。 10 分毎の更新や起動時リフレッシュは
   * false で、 既存があれば更新・無ければ skip する (削除済みチャンネルを作り直さない)。
   */
  allowCreate?: boolean;
}

export async function upsertSessionStatusCard(
  deps: SessionStatusCardDeps,
  sessionId: string,
  opts: UpsertStatusCardOptions = {},
): Promise<void> {
  const sessionRow = deps.sessionsRepo.findSession(sessionId);
  if (!sessionRow) return;
  const sessionChannelRow = deps.sessionChannelsRepo.findBySessionId(sessionId);
  if (!sessionChannelRow) return;

  const meta = readMeta(sessionRow.metadata);
  const persona = meta.persona_id ? deps.personasRepo.find(meta.persona_id) : null;
  const statusChannel = await ensureStatusChannel(deps, {
    sessionId,
    provider: sessionRow.provider,
    roleLabel: meta.role_label ?? null,
    personaDisplayName: persona?.display_name ?? null,
    allowCreate: opts.allowCreate ?? false,
  });
  if (!statusChannel) return;

  const taskRows = deps.sessionTaskRecordsRepo.listBySession(sessionId);
  const openTasks = taskRows.filter((t) => t.status !== "completed");
  const inProgress = openTasks.filter((t) => t.status === "in_progress");
  const pending = openTasks.filter((t) => t.status === "pending");
  const doneCount = taskRows.filter((t) => t.status === "completed").length;

  // 直近活動の判定: session_events の最新 ts と現在の差で 作業中 / 待機 / アイドル を出す.
  // last_seen_at は heartbeat なので使わない (内容変化がなくても進むため).
  const recent = deps.sessionsRepo.recentEvents(sessionId, 1);
  const lastEventTsSec = recent.length > 0 ? recent[0].ts : null;
  const ageSec = lastEventTsSec === null ? null : Math.floor(Date.now() / 1000) - lastEventTsSec;

  // Concordia から会話 / 指示 系の未配信 pending task が何件待たされているか.
  // タスクを送ったのに session が拾ってくれていない、 を見える化する.
  const concordiaPending = deps.tasksRepo.countUndeliveredForSession(sessionId);

  const embed = buildSessionStatusEmbed({
    sessionId,
    provider: sessionRow.provider,
    branch: sessionRow.branch,
    repoPath: sessionRow.repo_path,
    currentTask: sessionRow.current_task,
    status: sessionRow.status,
    ageSec,
    personaText: personaLabel(meta.role_label ?? null, persona?.display_name ?? null, persona?.name ?? null),
    sessionChannelId: sessionChannelRow.channel_id,
    inProgress,
    pending,
    doneCount,
    concordiaPending,
  });

  const msgKey = `${STATUS_MESSAGE_KEY_PREFIX}${sessionId}`;
  const chKey = `${STATUS_CHANNEL_KEY_PREFIX}${sessionId}`;
  // Unknown Channel (10003) が来たらチャンネルが Discord 側で削除済みの確定サイン。
  // warn を出さず info でキャッシュだけ破棄して終了 → 次 tick で allowCreate=true なら再作成。
  // (warn にすると looksLikeFailure でエラーチャンネルへ転記されノイズになる)
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
      if ((e as { code?: number }).code === 10003) { handleUnknownChannel(); return; }
      // Unknown Message (10008) 等 → 再作成パスへ fall through
    }
  }

  // message id を失った再作成パス: チャンネルに残った古い bot カードを掃除してから
  // 1 枚だけ送り直す (1 チャンネルにカードが複数並ぶ重複を防ぐ)。
  try {
    await purgeBotMessages(deps, statusChannel); // Unknown Channel は re-throw
    const sent = await statusChannel.send({ embeds: [embed] });
    deps.configRepo.set(msgKey, sent.id);
    deps.log.info(`status-card: created session=${sessionId} channel=${statusChannel.id} message=${sent.id}`);
  } catch (e) {
    if ((e as { code?: number }).code === 10003) { handleUnknownChannel(); return; }
    deps.configRepo.set(msgKey, "");
    deps.log.warn(
      `status-card: send failed session=${sessionId} channel=${statusChannel.id}: ${(e as Error).message}`,
    );
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
}

/**
 * 状態カードの Embed を組み立てる純粋関数 (送信副作用なし → 単体テスト可能)。
 *
 * 整理方針:
 *  - 色で状態を即時把握 (🟢作業中=緑 / 🟡待機=黄 / それ以外=グレー)。
 *  - persona をタイトル、 current task を強調行に。 冗長な「Updated」行は footer の
 *    timestamp に集約し、 Repo はフルパスではなくリポ名を field に出す (フルパスは footer)。
 *  - タスクは「N ▶ / N ⏳ / N ✓ ・依頼残 N」の見出し + 開いているものだけ列挙。
 */
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
    (i.concordiaPending > 0 ? ` ・ 依頼残 ${i.concordiaPending}` : "");

  const descParts: string[] = [];
  if (i.currentTask) descParts.push(`**${truncate(i.currentTask, 200)}**`);
  descParts.push(`<#${i.sessionChannelId}>`);

  return new EmbedBuilder()
    .setColor(statusColor(i.status, i.ageSec))
    .setTitle((i.personaText && i.personaText !== "-" ? i.personaText : i.provider).slice(0, 250))
    .setDescription(descParts.join("\n"))
    .addFields(
      { name: "状態", value: statusValue, inline: true },
      { name: "Agent", value: `\`${i.provider}\``, inline: true },
      { name: "Branch", value: `\`${i.branch ?? "-"}\``, inline: true },
      { name: "Repo", value: `\`${repoName}\``, inline: true },
      { name: `タスク (${taskHeader})`, value: taskValue, inline: false },
    )
    .setFooter({ text: `session ${shortId} · ${truncate(i.repoPath, 80)}` })
    .setTimestamp(new Date());
}

/** 状態 + 直近活動から Embed のアクセントカラーを決める。 */
function statusColor(status: string, ageSec: number | null): number {
  if (status !== "active") return 0x747f8d; // ended / lost → グレー
  if (ageSec !== null && ageSec <= ACTIVE_WINDOW_SEC) return 0x3ba55d; // 作業中 → 緑
  if (ageSec !== null && ageSec <= WAITING_WINDOW_SEC) return 0xfaa61a; // 待機 → 黄
  return 0x747f8d; // アイドル → グレー
}

/** 状態カード channel に残った自分(bot)の過去メッセージを一掃する (重複カード防止)。
 *  Unknown Channel (10003) は呼び出し元で一元処理するため re-throw する。 */
async function purgeBotMessages(deps: SessionStatusCardDeps, channel: TextChannel): Promise<void> {
  try {
    const msgs = await channel.messages.fetch({ limit: 10 });
    const selfId = deps.guild.client.user?.id;
    for (const m of msgs.values()) {
      if (selfId && m.author.id !== selfId) continue;
      try { await m.delete(); } catch { /* best-effort */ }
    }
  } catch (e) {
    if ((e as { code?: number }).code === 10003) throw e; // Unknown Channel → 呼び出し元へ
    deps.log.warn(`status-card: purge failed channel=${channel.id}: ${(e as Error).message}`);
  }
}

async function ensureStatusChannel(
  deps: SessionStatusCardDeps,
  input: { sessionId: string; provider: string; roleLabel: string | null; personaDisplayName: string | null; allowCreate: boolean },
): Promise<TextChannel | null> {
  const key = `${STATUS_CHANNEL_KEY_PREFIX}${input.sessionId}`;
  const base = sessionChannelSlug(input.provider, input.roleLabel).slice(0, 80);
  // 状態カード channel はセッションごとにユニークにする。 base 名 (例 "claude-anon")
  // は匿名セッション間で衝突するため、 必ず session id 断片を混ぜる。 これを怠ると
  // 複数セッションが同名 `<base>-status` を名前一致で共有し、 互いのカードを上書き
  // し合う (= 投稿が隣にずれて見える混線。 2026-06-03 実害: 3 セッションが 1 channel)。
  const shortId = input.sessionId.replace(/^lictor-/, "").slice(0, 6);
  const name = `${base}-${shortId}-status`.slice(0, 95);
  const cached = deps.configRepo.get(key);
  if (cached) {
    const ch = deps.guild.channels.cache.get(cached);
    // 名前が現行の期待ユニーク名と一致する時だけ再利用。 旧来の共有 channel
    // (例 "claude-anon-status") を指している場合は不一致 → 下で自分専用を作り直す
    // (self-heal)。 取り残された共有 channel は status sweep が orphan として掃除する。
    if (ch && ch.type === ChannelType.GuildText && ch.name === name) return ch;
  }

  const existing = deps.guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.parentId === deps.layout.statusCategoryId && c.name === name,
  );
  if (existing && existing.type === ChannelType.GuildText) {
    deps.configRepo.set(key, existing.id);
    return existing;
  }

  // 作成は spawn 時 (allowCreate) のみ。 それ以外 (10分毎更新 / 起動時リフレッシュ) は
  // 既存が無ければ作り直さず skip する (削除済みチャンネルの再生成・量産を防ぐ)。
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

function readMeta(s: string | null | undefined): { persona_id?: string; role_label?: string } {
  if (!s) return {};
  try { return JSON.parse(s) as { persona_id?: string; role_label?: string }; } catch { return {}; }
}

function personaLabel(roleLabel: string | null, displayName: string | null, fallbackName: string | null): string {
  if (roleLabel && displayName) return `${roleLabel} / ${displayName}`;
  if (roleLabel && fallbackName) return `${roleLabel} / ${fallbackName}`;
  return roleLabel ?? displayName ?? fallbackName ?? "-";
}

/**
 * 直近 event ts と session status から「作業中 / 待機 / アイドル」 のラベルを作る.
 *  - session.status が ended / lost なら活動判定はせず、 そのまま表示しない
 *  - active で 60s 以内に event → 🟢 作業中 (Ns ago)
 *  - active で 60s〜300s → 🟡 待機
 *  - active で 300s+ または event 無し → ⚪ アイドル
 */
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

type StatusCardCleanupDeps = {
  guild: Guild;
  configRepo: DiscordConfigRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
};

// End-Session 等で、対応する状態カード (<base>-status チャンネル + config id) を削除する。
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
        // Unknown Channel (10003) = Discord 側で既に消えている → 目的達成と同義。
        // warn にすると looksLikeFailure でエラーチャンネルに転記されるので info に留める。
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

// lost / ended / abandoned / 消滅した session の状態カードを一掃する (1 時間ごとの整理)。
// active な session のカードは残す。configRepo の session_status_channel_id:* を走査する。
export async function reconcileLostStatusCards(
  deps: StatusCardCleanupDeps & { sessionsRepo: SessionsRepo },
): Promise<{ scanned: number; removed: number }> {
  let scanned = 0;
  let removed = 0;
  for (const [key, value] of Object.entries(deps.configRepo.all())) {
    if (!key.startsWith(STATUS_CHANNEL_KEY_PREFIX)) continue;
    if (!value) continue;
    scanned += 1;
    const sessionId = key.slice(STATUS_CHANNEL_KEY_PREFIX.length);
    const session = deps.sessionsRepo.findSession(sessionId);
    if (session && session.status === "active") continue; // active は残す
    await deleteSessionStatusCard(deps, sessionId);
    removed += 1;
  }
  return { scanned, removed };
}

