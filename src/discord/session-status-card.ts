import { ChannelType, type Guild, type TextChannel } from "discord.js";
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

export async function upsertSessionStatusCard(
  deps: SessionStatusCardDeps,
  sessionId: string,
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
  const activityLabel = buildActivityLabel(sessionRow.status, ageSec);

  // Concordia から会話 / 指示 系の未配信 pending task が何件待たされているか.
  // タスクを送ったのに session が拾ってくれていない、 を見える化する.
  const concordiaPending = deps.tasksRepo.countUndeliveredForSession(sessionId);

  const lines: string[] = [];
  lines.push("## Session Status");
  lines.push(`- Session: \`${sessionId}\``);
  lines.push(`- Persona: ${personaLabel(meta.role_label ?? null, persona?.display_name ?? null, persona?.name ?? null)}`);
  lines.push(`- Agent: \`${sessionRow.provider}\``);
  lines.push(`- Branch: \`${sessionRow.branch ?? "-"}\``);
  lines.push(`- Repo: \`${sessionRow.repo_path}\``);
  lines.push(`- Current Task: ${sessionRow.current_task ?? "-"}`);
  lines.push(`- Status: \`${sessionRow.status}\` ${activityLabel}`);
  lines.push(`- Session Channel: <#${sessionChannelRow.channel_id}>`);
  lines.push(`- Updated: <t:${Math.floor(Date.now() / 1000)}:R>`);
  lines.push("");
  // タスクサマリ: in_progress / pending / completed のカウントを一行で.
  // Concordia 依頼 (未配信 pending_tasks) も同じ行に置いて、 「session が拾ってない依頼が
  // 残ってるか」 を一目で見えるようにする.
  lines.push(
    `### Tasks (` +
      `${inProgress.length} in_progress / ${pending.length} pending / ${doneCount} done` +
      (concordiaPending > 0 ? ` ・ Concordia 依頼残: ${concordiaPending}` : "") +
      `)`,
  );
  if (openTasks.length === 0) {
    lines.push("- (no open tasks)");
  } else {
    for (const t of inProgress.slice(0, 5)) lines.push(`- [in_progress] ${truncate(t.active_form || t.task_text, 160)}`);
    for (const t of pending.slice(0, 10)) lines.push(`- [pending] ${truncate(t.task_text, 160)}`);
  }
  const body = lines.join("\n").slice(0, 3900);

  const key = `${STATUS_MESSAGE_KEY_PREFIX}${sessionId}`;
  const messageId = deps.configRepo.get(key);
  try {
    if (messageId) {
      const msg = await statusChannel.messages.fetch(messageId);
      await msg.edit({ content: body });
      return;
    }
  } catch {
    // fall through and recreate
  }

  const sent = await statusChannel.send({ content: body });
  deps.configRepo.set(key, sent.id);
  deps.log.info(`status-card: created session=${sessionId} channel=${statusChannel.id} message=${sent.id}`);
}

async function ensureStatusChannel(
  deps: SessionStatusCardDeps,
  input: { sessionId: string; provider: string; roleLabel: string | null; personaDisplayName: string | null },
): Promise<TextChannel | null> {
  const key = `${STATUS_CHANNEL_KEY_PREFIX}${input.sessionId}`;
  const cached = deps.configRepo.get(key);
  if (cached) {
    const ch = deps.guild.channels.cache.get(cached);
    if (ch && ch.type === ChannelType.GuildText) return ch;
  }

  const base = sessionChannelSlug(input.provider, input.roleLabel).slice(0, 80);
  const name = `${base}-status`.slice(0, 95);
  const existing = deps.guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.parentId === deps.layout.statusCategoryId && c.name === name,
  );
  if (existing && existing.type === ChannelType.GuildText) {
    deps.configRepo.set(key, existing.id);
    return existing;
  }

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

