import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { DiscordConfigRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { PersonasRepo } from "../db/personas-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { sessionChannelSlug } from "./formatter.js";

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

  const lines: string[] = [];
  lines.push("## Session Status");
  lines.push(`- Session: \`${sessionId}\``);
  lines.push(`- Persona: ${personaLabel(meta.role_label ?? null, persona?.display_name ?? null, persona?.name ?? null)}`);
  lines.push(`- Agent: \`${sessionRow.provider}\``);
  lines.push(`- Branch: \`${sessionRow.branch ?? "-"}\``);
  lines.push(`- Repo: \`${sessionRow.repo_path}\``);
  lines.push(`- Current Task: ${sessionRow.current_task ?? "-"}`);
  lines.push(`- Status: \`${sessionRow.status}\``);
  lines.push(`- Session Channel: <#${sessionChannelRow.channel_id}>`);
  lines.push(`- Updated: <t:${Math.floor(Date.now() / 1000)}:R>`);
  lines.push("");
  lines.push("### Tasks");
  if (openTasks.length === 0) {
    lines.push("- (no open tasks)");
  } else {
    for (const t of inProgress.slice(0, 5)) lines.push(`- [in_progress] ${truncate(t.active_form || t.task_text, 160)}`);
    for (const t of pending.slice(0, 10)) lines.push(`- [pending] ${truncate(t.task_text, 160)}`);
  }
  lines.push(`- Completed: ${doneCount}`);
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 3)}...`;
}

