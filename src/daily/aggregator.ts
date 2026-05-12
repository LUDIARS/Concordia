/**
 * 1 日 (local time) の sessions / events を集約して day_reports.bullets を作る.
 *
 * Concordia は server local time の YYYY-MM-DD を 1 日とみなす. 23:59 の session も
 * その日の bullets に入る. 翌 0:00 の session は次の日.
 */

import type { SessionRow } from "../shared/types.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

export interface DayBullets {
  date_iso: string;
  session_count: number;
  total_duration_sec: number;
  outcomes: { ended: number; lost: number; abandoned: number; active: number };
  events: Record<string, number>;       // 全 session 横断
  files: { edited: string[]; created: string[]; deleted: string[] };
  todos: { completed: number; in_progress: number; pending: number };
  branches: string[];
  repos: string[];
  roles: Record<string, number>;        // role 名 → 出現 session 数
  per_session: Array<{
    id: string;
    role: string;
    repo: string | null;
    branch: string | null;
    started_at: number;
    ended_at: number | null;
    duration_sec: number;
    status: string;
    event_total: number;
  }>;
}

export function dayRange(date: Date): { startTs: number; endTs: number; iso: string } {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const start = new Date(y, m, d, 0, 0, 0, 0);
  const end = new Date(y, m, d + 1, 0, 0, 0, 0);
  return {
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
    iso: `${y}-${pad(m + 1)}-${pad(d)}`,
  };
}

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

export function aggregateDay(
  date_iso: string,
  sessions: SessionRow[],
  sessionsRepo: SessionsRepo,
): DayBullets {
  const bullets: DayBullets = {
    date_iso,
    session_count: sessions.length,
    total_duration_sec: 0,
    outcomes: { ended: 0, lost: 0, abandoned: 0, active: 0 },
    events: {},
    files: { edited: [], created: [], deleted: [] },
    todos: { completed: 0, in_progress: 0, pending: 0 },
    branches: [],
    repos: [],
    roles: {},
    per_session: [],
  };

  const editedFiles = new Set<string>();
  const createdFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const branches = new Set<string>();
  const repos = new Set<string>();

  for (const s of sessions) {
    bullets.outcomes[s.status as keyof DayBullets["outcomes"]]++;
    const endedAt = s.ended_at ?? s.last_seen_at;
    const dur = Math.max(0, endedAt - s.started_at);
    bullets.total_duration_sec += dur;

    const meta = parseMeta(s.metadata);
    const role = meta.role_label ?? "雑用係";
    bullets.roles[role] = (bullets.roles[role] ?? 0) + 1;

    if (s.branch) branches.add(s.branch);
    if (s.repo_origin) repos.add(s.repo_origin);
    else if (s.repo_path) repos.add(s.repo_path);

    let evCount = 0;
    const events = sessionsRepo.allEvents(s.id);
    for (const ev of events) {
      bullets.events[ev.kind] = (bullets.events[ev.kind] ?? 0) + 1;
      evCount++;
      const payload = safeParse(ev.payload);
      if (ev.kind === "edit" && typeof payload?.file === "string") {
        if (payload.created) createdFiles.add(payload.file);
        else if (payload.deleted) deletedFiles.add(payload.file);
        else editedFiles.add(payload.file);
      }
      if (ev.kind === "task_update" && Array.isArray(payload?.todos)) {
        for (const t of payload.todos) {
          const st = (t?.status ?? "").toLowerCase();
          if (st === "completed") bullets.todos.completed++;
          else if (st === "in_progress") bullets.todos.in_progress++;
          else bullets.todos.pending++;
        }
      }
    }

    bullets.per_session.push({
      id: s.id,
      role,
      repo: s.repo_origin ?? s.repo_path ?? null,
      branch: s.branch,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_sec: dur,
      status: s.status,
      event_total: evCount,
    });
  }

  bullets.files.edited = [...editedFiles];
  bullets.files.created = [...createdFiles];
  bullets.files.deleted = [...deletedFiles];
  bullets.branches = [...branches];
  bullets.repos = [...repos];

  return bullets;
}

function parseMeta(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}
