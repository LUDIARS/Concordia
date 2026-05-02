/**
 * Concordia SQLite schema. spec/service-schema.md §2 に準拠.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 2;

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

  `CREATE INDEX IF NOT EXISTS idx_sessions_repo_active ON sessions(repo_origin, status)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_status      ON sessions(status, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_host        ON sessions(host, status)`,

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
