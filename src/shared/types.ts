/**
 * Concordia core types. spec/service-schema.md と整合.
 */

export type SessionStatus = "active" | "ended" | "lost" | "abandoned";

export type ProviderName =
  | "claude-code"
  | "gemini-cli"
  | "codex-cli"
  | "unknown";

export interface SessionRow {
  id: string;
  provider: ProviderName;
  repo_path: string;
  repo_origin: string | null;
  branch: string | null;
  host: string;
  started_at: number;
  ended_at: number | null;
  status: SessionStatus;
  last_seen_at: number;
  current_task: string | null;
  transcript_path: string | null;
  metadata: string | null; // JSON
}

export interface SessionEventRow {
  id: number;
  session_id: string;
  ts: number;
  kind: string;
  payload: string; // JSON
}

export interface SessionReportRow {
  session_id: string;
  generated_at: number;
  summary_md: string;
  bullets: string; // JSON
  duration_sec: number;
  metadata: string | null;
}

export type EventKind =
  | "start"
  | "prompt"
  | "edit"
  | "tool_call"
  | "task_update"
  | "compact"
  | "lost"
  | "recovered"
  | "end"
  | "note";
