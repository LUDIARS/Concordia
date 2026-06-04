/**
 * Concordia SQLite schema. spec/service-schema.md §2 に準拠.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 21;

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
  // generated=1 は「投稿者(セッション)の活動シグナルから動的生成された人格」.
  // seed (固定10体, generated=0) と区別し、 assign() のランダム自由枠から除外する
  // (生成人格は origin_session_id のセッション専用で、 他セッションに配られない).
  `CREATE TABLE IF NOT EXISTS personas (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    traits            TEXT NOT NULL DEFAULT '[]',
    speech_style      TEXT NOT NULL DEFAULT '',
    skill_template    TEXT NOT NULL DEFAULT '',
    learned_notes     TEXT NOT NULL DEFAULT '[]',
    display_name      TEXT NOT NULL DEFAULT '',
    generated         INTEGER NOT NULL DEFAULT 0,
    origin_session_id TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
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

  // ─── transcript logs (v0.5 — session log 永続化) ──────
  // Lictor の transcript-tail が POST する transcript frame (Claude/Codex 内部 JSONL
  // から抽出した user/assistant/tool_use/tool_result/thinking) を per-session で
  // 全件保存する. discrete event (start/prompt/edit/end) を扱う session_events
  // とは別ストレージ — frame は 1 session あたり数百〜数千件になり events feed の
  // S/N 比を壊すため.
  //
  // (session_id, seq) で UNIQUE: tail の再送 / 重複 POST に対して冪等性を確保.
  // seq は Lictor 側のシーケンス番号 (transcript-tail.ts の seq++ カウンタ) で
  // 0 から始まる単調増加. session 内で一意.
  `CREATE TABLE IF NOT EXISTS transcript_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    ts          INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    UNIQUE(session_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_logs_session_ts
     ON transcript_logs(session_id, ts)`,

  // ─── Discord-UI integration (spec/discord-ui.md) ─────────────────────────
  // env CONCORDIA_DISCORD_ENABLED=1 が無ければ全部 no-op で touched されない.

  // bot 設定の key/value 永続化 (guild_id / category_id / meta channel_id).
  `CREATE TABLE IF NOT EXISTS discord_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // session ↔ Discord channel の対応表 + 状態.
  //   status: 'active' (🟢) / 'lost' (🟥) / 'ended' (⚪)
  //   last_rename_ts: Discord の channel rename rate limit (実測 5-10min) を尊重するための guard.
  //   webhook_id/token: 投稿用 webhook (persona name で per-message 上書き).
  `CREATE TABLE IF NOT EXISTS discord_session_channels (
    session_id      TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    webhook_id      TEXT,
    webhook_token   TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    last_rename_ts  INTEGER NOT NULL DEFAULT 0,
    ts              INTEGER NOT NULL
  )`,

  // Discord message id ↔ chat_messages.id の解決表. reaction を Concordia 内部
  // ID に解決するために必要 (Discord は message_id しか持たない).
  `CREATE TABLE IF NOT EXISTS discord_message_map (
    discord_message_id  TEXT PRIMARY KEY,
    chat_message_id     INTEGER NOT NULL,
    ts                  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discord_message_map_chat
     ON discord_message_map(chat_message_id)`,

  // reaction (fine / bad / raw) 記録. UNIQUE で同一 user × 同一 emoji の重複付け
  // 直しを防ぐ. message_id は chat_messages.id (Concordia 内部).
  `CREATE TABLE IF NOT EXISTS chat_message_reactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id       INTEGER NOT NULL,
    discord_user_id  TEXT NOT NULL,
    kind             TEXT NOT NULL,
    ts               INTEGER NOT NULL,
    UNIQUE (message_id, discord_user_id, kind)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_message_reactions_message
     ON chat_message_reactions(message_id)`,

  `CREATE TABLE IF NOT EXISTS discord_pending_questions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL,
    question            TEXT NOT NULL,
    options_json        TEXT NOT NULL,
    discord_message_id  TEXT,
    answered_at         INTEGER,
    answer_index        INTEGER,
    answer_text         TEXT,
    ts                  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discord_pending_questions_session
     ON discord_pending_questions(session_id, answered_at)`,

  // ─── Delegation templates (v0.3) ──────────────────────────
  // AI エージェント間のタスク委託テンプレート + 実行履歴.
  // spec/delegation.md §2 が schema の正本.
  `CREATE TABLE IF NOT EXISTS delegation_templates (
    id                TEXT    PRIMARY KEY,
    call_name         TEXT    NOT NULL UNIQUE,
    title             TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    target_provider   TEXT    NOT NULL,
    model             TEXT,
    prompt_template   TEXT    NOT NULL,
    input_schema      TEXT    NOT NULL DEFAULT '[]',
    default_cwd       TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_templates_active
     ON delegation_templates(is_active, call_name)`,

  `CREATE TABLE IF NOT EXISTS delegation_runs (
    id                  TEXT    PRIMARY KEY,
    template_id         TEXT,
    call_name           TEXT    NOT NULL,
    target_provider     TEXT    NOT NULL,
    args_json           TEXT    NOT NULL DEFAULT '{}',
    rendered_prompt     TEXT    NOT NULL,
    prompt_file_path    TEXT    NOT NULL,
    spawn_pid           INTEGER,
    spawn_command       TEXT,
    triggered_by        TEXT,
    status              TEXT    NOT NULL,
    error               TEXT,
    created_at          INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_created
     ON delegation_runs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_call_name
     ON delegation_runs(call_name, created_at DESC)`,

  // ─── PR queue (v0.6 — おのおののセッションが作った PR を 1 本のキューに) ──────
  // 各 active session が /v1/stat に報告する open_prs[] から派生 UPSERT (第一情報源)
  // + GitHub reconcile tick (merged/closed/ci/review を確定) で状態を維持する.
  // 「キュー」 = review_state / state で優先度順に並べ、 レビュー/マージ待ちを上に出す.
  // 1 PR = 1 行. UNIQUE(repo_origin, number) で同一 PR の重複登録を防ぐ.
  `CREATE TABLE IF NOT EXISTS pr_records (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_origin        TEXT NOT NULL,                 -- 正規化した owner/repo (例 LUDIARS/Concordia)
    repo_path          TEXT,                          -- ローカル判別補助 (任意)
    number             INTEGER NOT NULL,              -- PR 番号
    title              TEXT NOT NULL DEFAULT '',
    url                TEXT,
    head_branch        TEXT,
    base_branch        TEXT,
    state              TEXT NOT NULL DEFAULT 'open',  -- draft | open | merged | closed
    ci_status          TEXT NOT NULL DEFAULT 'unknown', -- unknown | pending | success | failure
    review_state       TEXT NOT NULL DEFAULT 'none',  -- none | needs_review | reviewing | approved | changes_requested
    author_session_id  TEXT,                          -- 誰 (どの session) が作ったか
    persona_id         TEXT,
    persona_name       TEXT,                          -- author_label 慣習に合わせた表示名 snapshot
    additions          INTEGER,
    deletions          INTEGER,
    changed_files      INTEGER,
    note               TEXT,
    created_at         INTEGER NOT NULL,              -- Concordia が最初に観測した時刻 (秒)
    updated_at         INTEGER NOT NULL,
    merged_at          INTEGER,
    closed_at          INTEGER,
    UNIQUE(repo_origin, number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pr_records_state ON pr_records(state, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pr_records_author ON pr_records(author_session_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_pr_records_repo ON pr_records(repo_origin, state)`,

  // ─── Slack platform (v0.1 — Discord と並ぶ ChatPlatform) ──────────────────
  // per-session チャンネルを作らず、設定した 1 チャンネル内で thread-per-session
  // で多重化する。session_id ↔ (channel_id, thread_ts) の対応を保持し、egress は
  // この thread に投稿、ingress は thread 返信を session inject に逆引きする。
  // spec/feature/slack-platform.md が正本。
  `CREATE TABLE IF NOT EXISTS slack_session_threads (
    session_id   TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    thread_ts    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',  -- active | ended
    ts           INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_slack_session_threads_thread
     ON slack_session_threads(channel_id, thread_ts)`,

  // Slack 連携設定をサービス内 (DB) で持つための key/value。discord_config と対の構成。
  // env (CONCORDIA_SLACK_*) は初期 bootstrap / フォールバックに残し、DB 値が優先。
  // ★ token (bot/app) は secret-box で暗号化した値を bot_token_enc / app_token_enc に保存し、
  //   平文では持たない (AIFormat §7 / coding-conventions §14)。channel_id / enabled は平文。
  `CREATE TABLE IF NOT EXISTS slack_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // ─── participants (人間入力者の identity レジストリ) ──────────────────────
  // platform handle ↔ 表示名 ↔ canonical 人物 の最小マッピング。発言者明示の
  // クロスプラットフォーム名前解決に使う (同名なら別PFでも同一人物とみなす)。
  // ★個人データ規約 (AIFormat §5): 本名/メール等の PII は持たず、platform handle と
  //   表示名のみ。loopback ローカル限定。spec/feature/participants.md が正本。
  `CREATE TABLE IF NOT EXISTS participants (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    platform          TEXT NOT NULL,            -- discord | slack
    platform_user_id  TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    canonical_name    TEXT NOT NULL,            -- 別PF名前解決キー (= 正規化した表示名)
    first_seen_at     INTEGER NOT NULL,
    last_seen_at      INTEGER NOT NULL,
    UNIQUE(platform, platform_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_participants_canonical ON participants(canonical_name)`,
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
  // 動的生成人格フラグ + 出自セッション (v0.x — persona dynamic generation).
  {
    table: "personas",
    column: "generated",
    ddl: `ALTER TABLE personas ADD COLUMN generated INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: "personas",
    column: "origin_session_id",
    ddl: `ALTER TABLE personas ADD COLUMN origin_session_id TEXT`,
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
  // delegation テンプレが spawn する CLI に渡すモデル (例 gpt-5.5 / claude-opus-4-8).
  // null = 各 provider CLI の config 既定モデルに委ねる (--model を付けない).
  {
    table: "delegation_templates",
    column: "model",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN model TEXT`,
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
