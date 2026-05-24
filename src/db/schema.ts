/**
 * Concordia SQLite schema. spec/service-schema.md §2 に準拠.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 12;

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
    metadata        TEXT,
    ws_clients      INTEGER NOT NULL DEFAULT 0
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

  // ─── session task records (v0.2.1 — TodoWrite 永続化) ──────────────
  // 各セッションが TodoWrite で扱った task の永続スナップショット.
  // task_update event を受信するたびに per-todo で UPSERT.
  // 同一 (session_id, task_text) は 1 行だけ、 status が completed に遷移した
  // 瞬間に completed_at + handled_by_session を確定し、 以降は touch されない
  // (= 同じテキストの task が後で pending に戻っても上書きしない、 履歴を保護).
  // session 終了時、 status != 'completed' な行 = 残作業.
  `CREATE TABLE IF NOT EXISTS session_task_records (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL,
    task_text           TEXT NOT NULL,
    active_form         TEXT,
    status              TEXT NOT NULL,
    first_seen_at       INTEGER NOT NULL,
    last_updated_at     INTEGER NOT NULL,
    completed_at        INTEGER,
    handled_by_session  TEXT,
    UNIQUE(session_id, task_text)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_task_records_session
     ON session_task_records(session_id, last_updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_task_records_status
     ON session_task_records(status, last_updated_at DESC)`,

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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    kind            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    delivered_at    INTEGER,
    expires_at      INTEGER NOT NULL,
    retries         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER
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
    display_name  TEXT NOT NULL DEFAULT '',
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

  // ─── observability (Excubitor 由来、 v0.3 で集約) ─────────
  // ホスト・サービスカタログ・インスタンス監視・エラー検知・自動修正の一式.
  // Postgres + UUID/JSONB/TIMESTAMPTZ から SQLite 用に dialect 変換.
  //   - UUID         → text PK (app 側で crypto.randomUUID)
  //   - JSONB        → text (JSON string)
  //   - BOOLEAN      → integer 0/1
  //   - TIMESTAMPTZ  → integer (epoch ms), default unixepoch() * 1000
  //   - TEXT[]       → text (JSON array string)
  //   - BIGSERIAL    → integer PK AUTOINCREMENT
  // Excubitor 側の table 名衝突 (process_logs) は service_instance_logs に rename.
  `CREATE TABLE IF NOT EXISTS hosts (
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    hostname          TEXT    NOT NULL,
    agent_version     TEXT,
    last_heartbeat_at INTEGER,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hosts_active ON hosts(is_active) WHERE is_active = 1`,

  `CREATE TABLE IF NOT EXISTS services (
    id               TEXT    PRIMARY KEY,
    code             TEXT    NOT NULL UNIQUE,
    name             TEXT    NOT NULL,
    catalog_snapshot TEXT    NOT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_services_active ON services(is_active) WHERE is_active = 1`,

  `CREATE TABLE IF NOT EXISTS service_instances (
    id              TEXT    PRIMARY KEY,
    service_id      TEXT    NOT NULL REFERENCES services(id),
    host_id         TEXT    REFERENCES hosts(id),
    pid             INTEGER,
    docker_id       TEXT,
    state           TEXT    NOT NULL DEFAULT 'unknown',
    last_seen_at    INTEGER,
    started_at      INTEGER,
    exit_code       INTEGER,
    git_branch      TEXT,
    git_hash        TEXT,
    git_dirty       INTEGER,
    package_version TEXT,
    port            INTEGER,
    extra           TEXT,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_si_service ON service_instances(service_id)`,
  `CREATE INDEX IF NOT EXISTS idx_si_host    ON service_instances(host_id)`,
  `CREATE INDEX IF NOT EXISTS idx_si_state   ON service_instances(state)`,

  `CREATE TABLE IF NOT EXISTS liveness_history (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    service_instance_id TEXT    NOT NULL REFERENCES service_instances(id),
    probed_at           INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    ok                  INTEGER NOT NULL,
    latency_ms          INTEGER,
    detail              TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lh_si_probed ON liveness_history(service_instance_id, probed_at DESC)`,

  // Excubitor の process_logs → service_instance_logs に rename. Concordia 既存の
  // process_logs (managed processes 由来) と区別.
  `CREATE TABLE IF NOT EXISTS service_instance_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    service_instance_id TEXT    NOT NULL REFERENCES service_instances(id),
    ts                  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    level               TEXT,
    line                TEXT    NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sil_si_ts ON service_instance_logs(service_instance_id, ts DESC)`,

  `CREATE TABLE IF NOT EXISTS error_rules (
    id            TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    pattern       TEXT    NOT NULL,
    pattern_type  TEXT    NOT NULL DEFAULT 'regex',
    severity      TEXT    NOT NULL DEFAULT 'error',
    service_codes TEXT,                                 -- JSON array (was TEXT[])
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_er_active ON error_rules(is_active) WHERE is_active = 1`,

  `CREATE TABLE IF NOT EXISTS error_tasks (
    id                  TEXT    PRIMARY KEY,
    rule_id             TEXT    REFERENCES error_rules(id),
    service_instance_id TEXT    REFERENCES service_instances(id),
    severity            TEXT    NOT NULL DEFAULT 'error',
    summary             TEXT    NOT NULL,
    log_excerpt         TEXT,
    occurrence_count    INTEGER NOT NULL DEFAULT 1,
    first_seen_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_seen_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    state               TEXT    NOT NULL DEFAULT 'open',
    snooze_until        INTEGER,
    triaged_by          TEXT,
    triaged_at          INTEGER,
    note                TEXT,
    auto_fix_state      TEXT,
    auto_fix_attempts   INTEGER NOT NULL DEFAULT 0,
    auto_fix_run_id     TEXT,
    created_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at          INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_et_state ON error_tasks(state) WHERE state IN ('open', 'ack', 'snoozed')`,
  `CREATE INDEX IF NOT EXISTS idx_et_si    ON error_tasks(service_instance_id, last_seen_at DESC)`,

  `CREATE TABLE IF NOT EXISTS auto_fix_runs (
    id              TEXT    PRIMARY KEY,
    error_task_id   TEXT    NOT NULL REFERENCES error_tasks(id),
    service_code    TEXT    NOT NULL,
    agent           TEXT    NOT NULL DEFAULT 'claude-code',
    state           TEXT    NOT NULL DEFAULT 'pending',
    triggered_by    TEXT,
    prompt          TEXT,
    started_at      INTEGER,
    finished_at     INTEGER,
    exit_code       INTEGER,
    stdout_tail     TEXT,
    stderr_tail     TEXT,
    branch          TEXT,
    commit_hash     TEXT,
    pr_url          TEXT,
    verify_result   TEXT,
    error_message   TEXT,
    action_type     TEXT    NOT NULL DEFAULT 'fix',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_afr_task        ON auto_fix_runs(error_task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_afr_state       ON auto_fix_runs(state)`,
  `CREATE INDEX IF NOT EXISTS idx_afr_action_type ON auto_fix_runs(action_type)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    actor       TEXT,
    action      TEXT    NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    payload     TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_ts       ON audit_log(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON audit_log(actor, ts DESC)`,

  // ─── session stats (v0.4 — 10 分 poll 集計) ───────────
  // 各 active session が自身の現況 (repos / branches / 未マージ / Todo 等) を JSON で
  // 報告したものを蓄積する. Concordia 内では他 session も GET で参照できる
  // (フラットなエージェントチームとして互いの状況を共有するため).
  `CREATE TABLE IF NOT EXISTS session_stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    payload     TEXT NOT NULL  -- JSON
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_stats_session_ts ON session_stats(session_id, ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_session_stats_ts ON session_stats(ts DESC)`,
];

// 冪等 ALTER: 既存 DB に新規 column を後追いするための差分マイグレーション.
// CREATE TABLE IF NOT EXISTS は新規スキーマには効くが、 既存 DB の column 追加には効かない.
// 各エントリは PRAGMA table_info で存在チェックしてから ALTER する.
const COLUMN_ADDITIONS: Array<{ table: string; column: string; ddl: string }> = [
  {
    table: "personas",
    column: "display_name",
    ddl: `ALTER TABLE personas ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`,
  },
  // 永続 WS クライアント方式: 接続生存で active を維持するためのカウンタ.
  // sweeper は ws_clients > 0 の session を「作業中」 と見なして lost 化しない.
  {
    table: "sessions",
    column: "ws_clients",
    ddl: `ALTER TABLE sessions ADD COLUMN ws_clients INTEGER NOT NULL DEFAULT 0`,
  },
  // stat-collect 等の pending_tasks に対する retry 機構.
  // 一定時間応答が無ければ delivered_at=NULL に戻して再配信、 上限到達で諦める.
  {
    table: "pending_tasks",
    column: "retries",
    ddl: `ALTER TABLE pending_tasks ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: "pending_tasks",
    column: "last_attempt_at",
    ddl: `ALTER TABLE pending_tasks ADD COLUMN last_attempt_at INTEGER`,
  },
];

function applyColumnAdditions(db: Database.Database): void {
  for (const a of COLUMN_ADDITIONS) {
    const cols = db.prepare(`PRAGMA table_info(${a.table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === a.column)) {
      db.exec(a.ddl);
    }
  }
}

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const tx = db.transaction((stmts: string[]) => {
    for (const stmt of stmts) db.exec(stmt);
  });
  tx(STATEMENTS);
  applyColumnAdditions(db);
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', ?)`,
  ).run(String(SCHEMA_VERSION));
}
