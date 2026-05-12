/**
 * Concordia SQLite schema. spec/service-schema.md §2 に準拠.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 7;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    repo_path       TEXT NOT NULL,
    repo_origin     TEXT,
    branch          TEXT,
    host            TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    status          TEXT NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    current_task    TEXT,
    transcript_path TEXT,
    metadata        TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_repo_path_active ON sessions(repo_path, status)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_repo_origin      ON sessions(repo_origin, status)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_status           ON sessions(status, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_host             ON sessions(host, status)`,

  `CREATE TABLE IF NOT EXISTS session_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL
  )`,

  `CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind    ON session_events(kind, ts)`,

  `CREATE TABLE IF NOT EXISTS session_reports (
    session_id   TEXT PRIMARY KEY,
    generated_at INTEGER NOT NULL,
    summary_md   TEXT NOT NULL,
    bullets      TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,
    metadata     TEXT
  )`,

  // ─── chat / tasks layer (v0.1) ──────────────────────
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    channel       TEXT NOT NULL,
    session_id    TEXT,
    author_label  TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    text          TEXT NOT NULL,
    in_reply_to   INTEGER,
    is_actionable INTEGER NOT NULL DEFAULT 0,
    metadata      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_channel_ts ON chat_messages(channel, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_session    ON chat_messages(session_id, ts DESC)`,

  `CREATE TABLE IF NOT EXISTS pending_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    payload      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER,
    expires_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_tasks(session_id, delivered_at, expires_at)`,

  // ─── skill snapshots (v0.1.2) ───────────────────────
  `CREATE TABLE IF NOT EXISTS skill_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_origin     TEXT,
    repo_path       TEXT NOT NULL,
    skill_name      TEXT NOT NULL,
    ts              INTEGER NOT NULL,
    content_hash    TEXT NOT NULL,
    content         TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    line_count      INTEGER NOT NULL,
    section_count   INTEGER NOT NULL,
    source          TEXT NOT NULL,
    poison_score    REAL NOT NULL DEFAULT 0,
    poison_reasons  TEXT NOT NULL DEFAULT '[]',
    growth_score    REAL NOT NULL DEFAULT 0,
    growth_notes    TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_skill_snapshots_repo
     ON skill_snapshots(repo_path, skill_name, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_snapshots_origin
     ON skill_snapshots(repo_origin, skill_name, ts DESC)`,

  // ─── rule engine (v0.1.3) ────────────────────────────
  `CREATE TABLE IF NOT EXISTS rules (
    id            TEXT PRIMARY KEY,
    description   TEXT,
    trigger_type  TEXT NOT NULL,         -- "tick" | "event"
    tick_sec      INTEGER,               -- trigger_type=tick の時
    event_kind    TEXT,                  -- trigger_type=event の時 (start/prompt/edit/end など)
    conditions    TEXT NOT NULL DEFAULT '[]',  -- JSON: 配列 (AND)
    instructions  TEXT NOT NULL,         -- claude CLI に渡す prompt の中核
    target        TEXT,                  -- channel name or null (AI が決める)
    cooldown_sec  INTEGER NOT NULL DEFAULT 60,
    last_fired_at INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    added_at      INTEGER NOT NULL,
    added_by      TEXT NOT NULL DEFAULT 'system',
    removed_at    INTEGER,
    removed_by    TEXT,
    removed_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled, trigger_type)`,

  `CREATE TABLE IF NOT EXISTS rules_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    rule_id   TEXT,
    action    TEXT NOT NULL,             -- add / remove / fire / skip / error
    detail    TEXT,
    actor     TEXT                       -- system / ai / human / engine
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rules_log_ts ON rules_log(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_rules_log_rule ON rules_log(rule_id, ts DESC)`,

  // ─── day reports (AI 日報、 v0.1.4) ────────────────────
  `CREATE TABLE IF NOT EXISTS day_reports (
    date_iso          TEXT PRIMARY KEY,             -- "2026-05-02" (local time)
    generated_at      INTEGER NOT NULL,
    summary_md        TEXT NOT NULL,
    bullets           TEXT NOT NULL,                -- aggregated JSON
    session_count     INTEGER NOT NULL,
    total_duration_sec INTEGER NOT NULL,
    metadata          TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_day_reports_generated ON day_reports(generated_at DESC)`,

  // ─── persona system (v0.1.5) ─────────────────────────
  // Concordia 経由で起動された AI セッションに人格を排他的に割当てる.
  // ユーザの skill / memory / FS には書かない. すべてここで完結.
  `CREATE TABLE IF NOT EXISTS personas (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    traits        TEXT NOT NULL DEFAULT '[]',
    speech_style  TEXT NOT NULL DEFAULT '',
    skill_template TEXT NOT NULL DEFAULT '',
    learned_notes TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS persona_assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    released_at INTEGER
  )`,
  // 排他: 1 persona が同時に複数 active session に割当たらないよう partial unique.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_active_persona
     ON persona_assignments(persona_id) WHERE released_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_active_session
     ON persona_assignments(session_id) WHERE released_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_pa_session ON persona_assignments(session_id, assigned_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pa_persona ON persona_assignments(persona_id, assigned_at DESC)`,

  `CREATE TABLE IF NOT EXISTS persona_feedback_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    persona_id  TEXT NOT NULL,
    session_id  TEXT,
    ts          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    delta       TEXT NOT NULL,
    detail      TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pfb_persona ON persona_feedback_log(persona_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pfb_session ON persona_feedback_log(session_id, ts DESC)`,

  // ─── managed processes (v0.2) ────────────────────────
  // Concordia が spawn / 監視するシェルプロセス. dev-process.md 由来 + API 直叩き.
  `CREATE TABLE IF NOT EXISTS processes (
    name         TEXT PRIMARY KEY,                  -- 識別名 (UNIQUE)
    cwd          TEXT NOT NULL,                     -- 絶対 cwd
    command      TEXT NOT NULL,                     -- shell 行
    repo_path    TEXT,                              -- 紐付く repo (dev-process.md の場所)
    repo_origin  TEXT,
    pid          INTEGER,                           -- 走行中のみ非 NULL
    status       TEXT NOT NULL,                     -- starting / running / exited / failed
    started_at   INTEGER,                           -- 最後に spawn した時刻
    exited_at    INTEGER,
    exit_code    INTEGER,
    exit_signal  TEXT,
    log_path     TEXT NOT NULL,                     -- ファイル出力先 (logs/<name>.log)
    metadata     TEXT                               -- JSON (env / error_patterns 等)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_processes_status ON processes(status)`,
  `CREATE INDEX IF NOT EXISTS idx_processes_repo   ON processes(repo_path, status)`,

  // ログ行 (永続化は最小限. ringbuffer は in-memory). API の ?since_ts pull 用.
  `CREATE TABLE IF NOT EXISTS process_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    process_name  TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    stream        TEXT NOT NULL,                    -- stdout / stderr / event
    level         TEXT,                             -- error / warn / info / null
    line          TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_process_logs_name_ts ON process_logs(process_name, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_process_logs_level ON process_logs(process_name, level, ts DESC)`,
];

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const tx = db.transaction((stmts: string[]) => {
    for (const stmt of stmts) db.exec(stmt);
  });
  tx(STATEMENTS);
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', ?)`,
  ).run(String(SCHEMA_VERSION));
}
