/**
 * セッション終了レポート生成.
 *
 * - bullets: 構造化集計 (events count / files / todos / outcome)
 * - summary_md: LLM サマライズ (ANTHROPIC_API_KEY 設定時) or template fallback
 *
 * spec/service-schema.md §7 準拠.
 */

import type { SessionEventRow, SessionReportRow, SessionRow } from "../shared/types.js";

export interface ReportBullets {
  duration_sec: number;
  events: Record<string, number>;
  files: { edited: string[]; created: string[]; deleted: string[] };
  todos: { completed: number; in_progress: number; pending: number };
  branches: string[];
  outcome: "ended" | "lost" | "abandoned";
}

export function aggregateBullets(
  session: SessionRow,
  events: SessionEventRow[],
): ReportBullets {
  const counts: Record<string, number> = {};
  const editedFiles = new Set<string>();
  const createdFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const branches = new Set<string>();
  let todos = { completed: 0, in_progress: 0, pending: 0 };

  for (const ev of events) {
    counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
    let payload: any;
    try {
      payload = JSON.parse(ev.payload);
    } catch {
      continue;
    }
    if (ev.kind === "edit" && typeof payload?.file === "string") {
      if (payload.created) createdFiles.add(payload.file);
      else if (payload.deleted) deletedFiles.add(payload.file);
      else editedFiles.add(payload.file);
    }
    if (ev.kind === "task_update" && payload && Array.isArray(payload.todos)) {
      const t = countTodos(payload.todos);
      todos = t;
    }
  }
  if (session.branch) branches.add(session.branch);

  const endedAt = session.ended_at ?? session.last_seen_at;
  const duration_sec = Math.max(0, endedAt - session.started_at);

  const outcome: ReportBullets["outcome"] =
    session.status === "ended"
      ? "ended"
      : session.status === "abandoned"
        ? "abandoned"
        : "lost";

  return {
    duration_sec,
    events: counts,
    files: {
      edited: [...editedFiles],
      created: [...createdFiles],
      deleted: [...deletedFiles],
    },
    todos,
    branches: [...branches],
    outcome,
  };
}

export function templateSummary(session: SessionRow, b: ReportBullets): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id}`);
  lines.push("");
  lines.push(`- **provider**: \`${session.provider}\``);
  lines.push(`- **repo**: \`${session.repo_origin ?? session.repo_path}\``);
  if (b.branches.length) lines.push(`- **branch**: ${b.branches.join(", ")}`);
  lines.push(`- **host**: ${session.host}`);
  lines.push(`- **duration**: ${formatDuration(b.duration_sec)}`);
  lines.push(`- **outcome**: ${b.outcome}`);
  lines.push("");
  lines.push(`## Activity`);
  for (const [kind, n] of Object.entries(b.events).sort((a, c) => c[1] - a[1])) {
    lines.push(`- ${kind}: ${n}`);
  }
  if (b.files.edited.length || b.files.created.length || b.files.deleted.length) {
    lines.push("");
    lines.push(`## Files`);
    if (b.files.edited.length)  lines.push(`- edited: ${b.files.edited.length} (${b.files.edited.slice(0, 5).join(", ")}${b.files.edited.length > 5 ? ", …" : ""})`);
    if (b.files.created.length) lines.push(`- created: ${b.files.created.length}`);
    if (b.files.deleted.length) lines.push(`- deleted: ${b.files.deleted.length}`);
  }
  if (b.todos.completed + b.todos.in_progress + b.todos.pending > 0) {
    lines.push("");
    lines.push(`## Todos`);
    lines.push(`- completed: ${b.todos.completed}`);
    lines.push(`- in_progress: ${b.todos.in_progress}`);
    lines.push(`- pending: ${b.todos.pending}`);
  }
  return lines.join("\n");
}

/**
 * LLM (Anthropic API) で要約. 失敗時は template fallback.
 * v0.1 では fetch で直叩き (SDK に依存しない). 詳細は v0.2 で claude-api skill 流用.
 */
export async function llmSummary(
  session: SessionRow,
  events: SessionEventRow[],
  cfg: { apiKey: string; model: string },
): Promise<string | null> {
  if (!cfg.apiKey) return null;
  const compact = events
    .filter((e) => ["prompt", "edit", "compact", "task_update", "lost"].includes(e.kind))
    .map((e) => ({ kind: e.kind, ts: e.ts, payload: safeParse(e.payload) }));

  const promptText =
    `You are summarizing an AI coding session. Output a concise markdown report (Japanese).\n` +
    `provider=${session.provider} repo=${session.repo_origin} branch=${session.branch ?? ""}\n` +
    `events:\n${JSON.stringify(compact).slice(0, 8000)}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 800,
        messages: [{ role: "user", content: promptText }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

export async function generateReport(
  session: SessionRow,
  events: SessionEventRow[],
  llm: { apiKey: string; model: string },
): Promise<SessionReportRow> {
  const bullets = aggregateBullets(session, events);
  const llmText = await llmSummary(session, events, llm);
  const summary_md = llmText ?? templateSummary(session, bullets);
  return {
    session_id: session.id,
    generated_at: nowSec(),
    summary_md,
    bullets: JSON.stringify(bullets),
    duration_sec: bullets.duration_sec,
    metadata: null,
  };
}

// ─── helpers ──────────────────────────────────────────

function countTodos(todos: any[]): { completed: number; in_progress: number; pending: number } {
  let completed = 0, in_progress = 0, pending = 0;
  for (const t of todos) {
    const st = (t?.status ?? "").toLowerCase();
    if (st === "completed") completed++;
    else if (st === "in_progress") in_progress++;
    else pending++;
  }
  return { completed, in_progress, pending };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h${m}m${s}s`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
