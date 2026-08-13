/**
 * Concordia core types. spec/service-schema.md と整合.
 */

export type SessionStatus = "active" | "blocked" | "ended" | "lost" | "abandoned";

export type ProviderName =
  | "claude-code"
  | "gemini-cli"
  | "codex-cli"
  /** Satelles (codex app-server 直叩き)。rollout JSONL を書かないので集計経路が別。 */
  | "codex-sdk"
  | "local-llm"
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
  /** 永続 WS client の接続数. > 0 なら sweeper の lost 判定から除外. */
  ws_clients: number;
  /**
   * 作業衝突監視で使う「このセッションが実際に扱う個別プロジェクト」の宣言 (repo path 推奨、
   * 安定識別子でも可)。 cwd がワークスペースルート (umbrella) でも、 宣言があればその
   * 個別プロジェクト単位で衝突判定する。 null なら repo_path に委ねる (conflict-scope.ts)。
   */
  target_project: string | null;
  team_id?: string | null;
  active_repos?: string;
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

export type ProcessStatus = "starting" | "running" | "exited" | "failed";

export type LogStream = "stdout" | "stderr" | "event";

export type LogLevel = "error" | "warn" | "info";

export interface ProcessRow {
  name: string;
  cwd: string;
  command: string;
  repo_path: string | null;
  repo_origin: string | null;
  pid: number | null;
  instance_id: string | null;
  generation: number;
  status: ProcessStatus;
  started_at: number | null;
  exited_at: number | null;
  exit_code: number | null;
  exit_signal: string | null;
  log_path: string;
  metadata: string | null; // JSON
}

export interface ProcessLogRow {
  id: number;
  process_name: string;
  ts: number;
  stream: LogStream;
  level: LogLevel | null;
  line: string;
}
