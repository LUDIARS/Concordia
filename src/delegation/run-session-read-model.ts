import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";

const LEGACY_LINK_WINDOW_MS = 10 * 60 * 1000;

export type SessionMetadataParser = (session: SessionRow) => Record<string, unknown>;

interface IndexedSession {
  row: SessionRow;
  runId: string | null;
  normalizedRepo: string;
  startedAtMs: number;
}

/**
 * delegation run と session の関連を、リクエスト内で一度だけ構築した索引から解決する。
 *
 * delegation_run_id がない旧 session は call_name + repo + 開始時刻で関連付ける。
 * call_name ごとの配列を開始時刻順に保持し、run ごとの探索を ±10 分の範囲に限定する。
 */
export class DelegationRunSessionReadModel {
  private readonly bySessionId = new Map<string, IndexedSession>();
  private readonly byRunId = new Map<string, IndexedSession[]>();
  private readonly legacyByCallName = new Map<string, IndexedSession[]>();

  constructor(sessions: readonly SessionRow[], parseMetadata: SessionMetadataParser = defaultParseMetadata) {
    for (const row of sessions) {
      const metadata = parseMetadata(row);
      const indexed: IndexedSession = {
        row,
        runId: stringValue(metadata.delegation_run_id),
        normalizedRepo: normalizePath(row.repo_path),
        startedAtMs: row.started_at * 1000,
      };
      this.bySessionId.set(row.id, indexed);

      if (indexed.runId) {
        append(this.byRunId, indexed.runId, indexed);
        continue;
      }
      const callName = stringValue(metadata.delegation_call_name);
      if (callName) append(this.legacyByCallName, callName, indexed);
    }

    for (const sessionsForCall of this.legacyByCallName.values()) {
      sessionsForCall.sort((a, b) => a.startedAtMs - b.startedAtMs);
    }
  }

  linkedSessions(row: DelegationRunRow, args: Record<string, unknown>): SessionRow[] {
    const linked = new Map<string, SessionRow>();
    if (row.child_session_id) {
      const child = this.bySessionId.get(row.child_session_id);
      if (child) linked.set(child.row.id, child.row);
    }
    for (const indexed of this.byRunId.get(row.id) ?? []) {
      linked.set(indexed.row.id, indexed.row);
    }

    const targetRepo = firstString(args, ["target_repo", "repo_path", "cwd"]);
    if (targetRepo) {
      const normalizedTarget = normalizePath(targetRepo);
      const candidates = this.legacyByCallName.get(row.call_name) ?? [];
      const lower = lowerBound(candidates, row.created_at - LEGACY_LINK_WINDOW_MS);
      const upper = upperBound(candidates, row.created_at + LEGACY_LINK_WINDOW_MS);
      for (let index = lower; index < upper; index += 1) {
        const candidate = candidates[index];
        if (!candidate) continue;
        if (candidate.normalizedRepo !== normalizedTarget
          && !candidate.normalizedRepo.startsWith(`${normalizedTarget}/`)) continue;
        linked.set(candidate.row.id, candidate.row);
      }
    }

    return [...linked.values()].sort((a, b) => b.started_at - a.started_at);
  }
}

function append(map: Map<string, IndexedSession[]>, key: string, value: IndexedSession): void {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}

function lowerBound(rows: readonly IndexedSession[], targetMs: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle]?.startedAtMs ?? Number.POSITIVE_INFINITY) < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(rows: readonly IndexedSession[], targetMs: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rows[middle]?.startedAtMs ?? Number.POSITIVE_INFINITY) <= targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function defaultParseMetadata(session: SessionRow): Record<string, unknown> {
  if (!session.metadata) return {};
  try {
    const parsed: unknown = JSON.parse(session.metadata);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringValue(obj[key]);
    if (value) return value;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
