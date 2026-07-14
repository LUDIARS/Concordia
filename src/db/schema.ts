/**
 * Concordia SQLite schema. spec/service-schema.md §2 に準拠.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 37;

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
    ws_clients      INTEGER NOT NULL DEFAULT 0,
    target_project  TEXT
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

  // ─── host metrics (v0.6 — PC パフォーマンススナップショット) ──────────
  // ホストのメモリ/CPU + 上位プロセス + WSL/docker + セッション別 RSS を 1 tick = 1 行
  // (payload JSON) で蓄積する。 Monitor は最新行を読み、 sparkline は時系列を走査する。
  `CREATE TABLE IF NOT EXISTS host_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sampled_at  INTEGER NOT NULL,
    payload     TEXT NOT NULL  -- JSON (HostSnapshot)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_host_metrics_ts ON host_metrics(sampled_at DESC)`,

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
    channel_kind    TEXT NOT NULL DEFAULT 'channel',
    webhook_id      TEXT,
    webhook_token   TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    last_rename_ts  INTEGER NOT NULL DEFAULT 0,
    scope           TEXT NOT NULL DEFAULT '',
    name_locked     INTEGER NOT NULL DEFAULT 0,
    ts              INTEGER NOT NULL
  )`,
  // inbound (channel → session) 解決用。 channel_id は歴史データに重複がありうるため
  // UNIQUE にはせず、 findByChannelId 側で「最新の active 束縛が勝つ」 を固定する。
  `CREATE INDEX IF NOT EXISTS idx_discord_session_channels_channel
     ON discord_session_channels(channel_id, status, ts)`,

  // 「いま何が起動テスト / 再起動中か」 の宣言レジストリ (テスト交通整備)。
  // セッションはサービスをテストする前に claim を宣言し、 Concordia が同一サービスの
  // 並行テストを検知して両セッションへ警告 inject する。 spec/feature/testing-traffic.md
  `CREATE TABLE IF NOT EXISTS service_test_claims (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    branch      TEXT,
    note        TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    released_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_service_test_claims_active
     ON service_test_claims(service, released_at, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_service_test_claims_session
     ON service_test_claims(session_id, released_at)`,

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
    multi_select        INTEGER NOT NULL DEFAULT 0,
    answer_indices_json TEXT,
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
    runtime_options_json TEXT NOT NULL DEFAULT '{}',
    prompt_template   TEXT    NOT NULL,
    input_schema      TEXT    NOT NULL DEFAULT '[]',
    default_cwd       TEXT,
    project           TEXT,                            -- 対象プロジェクト名 (cwd と別に delegation が持つ)
    is_active         INTEGER NOT NULL DEFAULT 1,
    emoji             TEXT    NOT NULL DEFAULT '',
    call_only         INTEGER NOT NULL DEFAULT 0,
    category          TEXT    NOT NULL DEFAULT 'employee',  -- employee | freelancer | parttimer (delegation-repo.ts DELEGATION_CATEGORIES が正本)
    sort_order        INTEGER NOT NULL DEFAULT 1000,
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
    parent_session_id   TEXT,
    child_session_id    TEXT,
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
  // 実行キュー: queued を FIFO で拾い、 spawned/running のスロット数を数える経路が使う。
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_status
     ON delegation_runs(status, created_at)`,
  // NOTE: parent_session_id / child_session_id の index は base schema ではなく
  // applyMigrations で applyColumnAdditions (列追加) の後に作る (delegationCoordinationIndexes)。
  // 既存 DB では CREATE TABLE IF NOT EXISTS が no-op で列が無いため、 base で index を
  // 張ると "no such column: parent_session_id" で起動失敗する。

  // ─── PR queue (v0.6 — おのおののセッションが作った PR を 1 本のキューに) ──────
  // 各 active session が /v1/stat に報告する open_prs[] から派生 UPSERT (第一情報源)
  // + GitHub reconcile tick (merged/closed/ci/review を確定) で状態を維持する.
  // 「キュー」 = review_state / state で優先度順に並べ、 レビュー/マージ待ちを上に出す.
  // 1 PR = 1 行. UNIQUE(repo_origin, number) で同一 PR の重複登録を防ぐ.
  // develop へ入った変更 1 件 = 確認 1 件。 ユーザが Discord で確認を開始/完了するまで残る。
  // 完了しても行は消さない (何をいつ確認したかの記録)。 spec/feature/develop-confirm-flow.md §4。
  `CREATE TABLE IF NOT EXISTS confirm_runs (
    id               TEXT    PRIMARY KEY,
    repo_origin      TEXT    NOT NULL,           -- owner/repo (例 LUDIARS/Concordia)
    repo_name        TEXT    NOT NULL,           -- ローカルクローンのディレクトリ名
    service_code     TEXT,                       -- Excubitor のサービスコード (null = 起動を伴わない)
    pr_number        INTEGER NOT NULL,
    pr_title         TEXT    NOT NULL DEFAULT '',
    pr_url           TEXT,
    develop_sha      TEXT,                       -- マージ後の develop HEAD (判明していれば)
    status           TEXT    NOT NULL,           -- pending | confirming | confirmed | rejected | failed
    memoria_task_id  INTEGER,                    -- Memoria に積んだ確認タスク (null = 連携失敗)
    error            TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE(repo_origin, pr_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_confirm_runs_status
     ON confirm_runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_confirm_runs_service
     ON confirm_runs(service_code, status)`,

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

  // Slack message ts → chat_messages.id の解決表 (discord_message_map と対の構成)。
  // egress で Concordia 投稿の ts を記録し、reaction_added 受信時に元 chat を逆引きして
  // リアクションワークフロー (👍 → 実装着手 等) に流す。spec/feature/reaction-workflow.md。
  `CREATE TABLE IF NOT EXISTS slack_message_map (
    channel_id      TEXT NOT NULL,
    ts              TEXT NOT NULL,
    chat_message_id INTEGER NOT NULL,
    recorded_at     INTEGER NOT NULL,
    PRIMARY KEY (channel_id, ts)
  )`,

  // Slack 連携設定をサービス内 (DB) で持つための key/value。discord_config と対の構成。
  // env (CONCORDIA_SLACK_*) は初期 bootstrap / フォールバックに残し、DB 値が優先。
  // ★ token (bot/app) は secret-box で暗号化した値を bot_token_enc / app_token_enc に保存し、
  //   平文では持たない (AIFormat §7 / coding-conventions §14)。channel_id / enabled は平文。
  `CREATE TABLE IF NOT EXISTS slack_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // chat-worker v2: core 停止中の副作用 HTTP を at-least-once で再送する durable outbox。
  // Authorization 等の secret header は保存せず、再送時にプロセス env から再構築する。
  `CREATE TABLE IF NOT EXISTS chat_mutation_outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    body_json   TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_mutation_outbox_created
     ON chat_mutation_outbox(created_at, id)`,

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

  // ─── model catalog (v0.x — delegation テンプレ/ spawn が選べるモデル一覧) ──────
  // delegation_templates.model / spawn の `--model` 値を「手動更新できる選択肢」として
  // 管理する。 値が頻繁に変わる (新モデル登場 / 旧モデル廃止) ので、 コードに直書きせず
  // DB で持ち Web UI (Settings) から CRUD する。 provider='any' は全 provider 共通候補。
  // spec/delegation.md §6 が正本。
  `CREATE TABLE IF NOT EXISTS model_catalog (
    id          TEXT    PRIMARY KEY,
    model_id    TEXT    NOT NULL,                  -- CLI --model に渡す実値 (例 claude-opus-4-8 / gpt-5.5)
    label       TEXT    NOT NULL DEFAULT '',       -- UI 表示名 (空なら model_id を表示)
    provider    TEXT    NOT NULL DEFAULT 'any',    -- any | claude | codex | gemini
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(provider, model_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_model_catalog_active
     ON model_catalog(is_active, sort_order, model_id)`,

  // ─── cost budget (v0.x — トークン日次予算 + 超過ブロック) ──────────────
  // 各ローカル日 (local "YYYY-MM-DD") に消費したトークン総量を蓄積する。
  // 「外部バッチ / 登録外セッション」も含めて全 Claude/Codex ログを走査し、
  // ファイル単位の累積トークンの増分 (delta) を today バケットに足し込む。
  // 予算超過判定 (tokens >= daily_token_budget) で Concordia 発の命令を止める。
  `CREATE TABLE IF NOT EXISTS cost_daily_usage (
    date_iso    TEXT PRIMARY KEY,                  -- local "YYYY-MM-DD"
    tokens      INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  )`,
  // ログファイル単位の「最後に観測した累積トークン」。 再起動を跨いで delta の
  // 二重計上を防ぐ (= 既存ファイルの累積を起動直後に today へ足さない)。
  `CREATE TABLE IF NOT EXISTS cost_log_seen (
    log_path    TEXT PRIMARY KEY,
    last_total  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  )`,

  // ─── 子会社 Delegation (v0.x) ─────────────────────────────────────────────
  // 別の Discord サーバ / Slack に出張する「子会社」。 専用 Bot + 専用 Delegation +
  // Sonnet ガードを持つ。 spec/feature/subsidiary-delegation.md が正本。
  // ★ bot_token_enc / app_token_enc は secret-box で暗号化した値のみ保存 (平文厳禁)。
  `CREATE TABLE IF NOT EXISTS subsidiaries (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL UNIQUE,           -- slug ^[a-z][a-z0-9_-]{0,63}$
    display_name    TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    platform        TEXT    NOT NULL DEFAULT 'discord', -- discord | slack
    enabled         INTEGER NOT NULL DEFAULT 0,
    guild_id        TEXT,                              -- Discord guild / Slack team
    application_id  TEXT,                              -- Discord slash 登録用 (任意)
    channel_id      TEXT,                              -- 依頼受付チャンネル
    bot_token_enc   TEXT,                              -- 暗号化 bot token
    app_token_enc   TEXT,                              -- 暗号化 Slack socket app token
    guard_model     TEXT    NOT NULL DEFAULT 'sonnet',
    guard_scope     TEXT    NOT NULL DEFAULT '',       -- 許可作業の自然文スコープ
    home_cwd        TEXT,                              -- [DEPRECATED] cwd は所有 delegation 側で管理 (subsidiary_delegations.default_cwd)。 列は後方互換で残すが未使用。
    daily_token_budget INTEGER NOT NULL DEFAULT 0,     -- 日次トークン予算 (0 = 無制限)。 超過で受付停止。
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,

  // 子会社が「所有する」 delegation の複製定義 (グローバル delegation_templates から clone)。
  // 旧版は (subsidiary_id, call_name) の薄い許可リストだったが、 cwd / project / prompt を
  // 子会社ごとに独立して持てるよう full copy へ拡張した (spec/feature/subsidiary-delegation.md §4)。
  // グローバルテンプレは別管理として残り、 ここはその時点の clone (以降は独立編集可)。
  `CREATE TABLE IF NOT EXISTS subsidiary_delegations (
    subsidiary_id   TEXT    NOT NULL,
    call_name       TEXT    NOT NULL,
    is_default      INTEGER NOT NULL DEFAULT 0,
    title           TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    target_provider TEXT    NOT NULL DEFAULT 'claude',
    model           TEXT,
    prompt_template TEXT    NOT NULL DEFAULT '',
    input_schema    TEXT    NOT NULL DEFAULT '[]',
    default_cwd     TEXT,                              -- cwd は子会社所有 delegation 側で管理
    project         TEXT,                              -- 対象プロジェクト名
    emoji           TEXT    NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (subsidiary_id, call_name)
  )`,

  // ロックされた依頼者 (ガードが lock 判定 / 手動ロック)。 以降ガード前に即 deny。
  `CREATE TABLE IF NOT EXISTS subsidiary_locks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    subsidiary_id     TEXT    NOT NULL,
    platform          TEXT    NOT NULL,
    platform_user_id  TEXT    NOT NULL,
    user_label        TEXT    NOT NULL DEFAULT '',
    reason            TEXT    NOT NULL DEFAULT '',
    locked_at         INTEGER NOT NULL,
    UNIQUE (subsidiary_id, platform, platform_user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subsidiary_locks_lookup
     ON subsidiary_locks(subsidiary_id, platform, platform_user_id)`,

  // 受信依頼 + ガード結論の監査ログ。
  `CREATE TABLE IF NOT EXISTS subsidiary_requests (
    id                 TEXT    PRIMARY KEY,
    subsidiary_id      TEXT    NOT NULL,
    platform           TEXT    NOT NULL,
    platform_user_id   TEXT    NOT NULL,
    user_label         TEXT    NOT NULL DEFAULT '',
    instruction        TEXT    NOT NULL,
    decision           TEXT    NOT NULL,               -- allow | deny
    reason             TEXT    NOT NULL DEFAULT '',
    violations_json    TEXT    NOT NULL DEFAULT '[]',
    matched_call_name  TEXT,
    locked             INTEGER NOT NULL DEFAULT 0,
    run_id             TEXT,                            -- allow 時に起動した delegation
    guard_model        TEXT    NOT NULL DEFAULT '',
    guard_raw          TEXT    NOT NULL DEFAULT '',
    created_at         INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subsidiary_requests_sub
     ON subsidiary_requests(subsidiary_id, created_at DESC)`,

  // 共通ハーネスルール (ダッシュボード設定)。 ガードプロンプトに自然文で列挙される。
  // builtin=1 は既定ルール (無効化可・削除不可)。
  `CREATE TABLE IF NOT EXISTS harness_rules (
    id          TEXT    PRIMARY KEY,
    kind        TEXT    NOT NULL,                       -- allow | block
    title       TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    builtin     INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_rules_order
     ON harness_rules(enabled, sort_order)`,

  // ローカルセッションのハーネス強制ゲートの監査ログ。 子会社 (subsidiary_requests) と
  // 同じ思想だが、 対象は外部依頼ではなく「自セッションの操作 (編集/コマンド)」。 すべての
  // 判定 (allow/deny/warn) を 1 行ずつ残し、 後から「強制が効いたか」を裏取りできるようにする。
  // event: inject(supply) | gate(判定) | block(fail-closed) | start_prompt | override。
  `CREATE TABLE IF NOT EXISTS harness_session_audit (
    id           TEXT    PRIMARY KEY,
    session_id   TEXT    NOT NULL DEFAULT '',
    project      TEXT    NOT NULL DEFAULT '',
    hook         TEXT    NOT NULL DEFAULT '',      -- supply | gate
    event        TEXT    NOT NULL,                 -- inject | gate | block | start_prompt | override
    tool         TEXT    NOT NULL DEFAULT '',      -- 試行ツール (Edit/Write/Bash/...)
    action       TEXT    NOT NULL DEFAULT '',      -- 操作の要約 (コマンド / パス)
    repo         TEXT    NOT NULL DEFAULT '',      -- 操作対象リポ root (max-repos 集計の状態源)
    rule         TEXT    NOT NULL DEFAULT '',      -- 当たった述語キー (空=該当なし)
    decision     TEXT    NOT NULL,                 -- allow | deny | warn
    reason       TEXT    NOT NULL DEFAULT '',
    detail_json  TEXT    NOT NULL DEFAULT '{}',
    ms           INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_harness_session_audit_created
     ON harness_session_audit(created_at DESC)`,
  // gate はツール実行毎に distinctEditedRepos (session_id + tool + repo) を引く。
  // session_id 系の索引が無いとテーブル成長に比例してフルスキャンが遅くなるため、
  // クエリを index-only で捌ける複合索引を張る (recent の session_id 絞りにも効く)。
  `CREATE INDEX IF NOT EXISTS idx_harness_session_audit_session_tool
     ON harness_session_audit(session_id, tool, repo)`,

  // ─── cost 使用量の時系列サンプル (10 分毎、 セッション別) ───────────────
  // 10 分毎に全 active セッションの「現在のコンテキスト占有」 と「累積消費トークン」 を
  // subsidiary/provider タグ付きで 1 行ずつ記録する。 これを時刻で繋いで WebUI の /cost に
  // 折れ線グラフ化し、 「いつ・誰が・どれだけ使ったか」 を可視化する (ユーザ要望)。
  // JSONL ローテートで消える生ログと違い、 ここに焼けば長期履歴が残る。
  `CREATE TABLE IF NOT EXISTS cost_usage_samples (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,            -- epoch 秒 (サンプル時刻)
    session_id     TEXT    NOT NULL,
    subsidiary_id  TEXT,                        -- null = 本社
    provider       TEXT,                        -- claude-code / codex-cli / ...
    context_tokens INTEGER,                     -- 現在のコンテキスト占有 (不明なら null)
    cost_tokens    INTEGER NOT NULL DEFAULT 0   -- 累積消費トークン (input+output)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_usage_samples_ts
     ON cost_usage_samples(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_usage_samples_session
     ON cost_usage_samples(session_id, ts)`,

  `CREATE TABLE IF NOT EXISTS cost_limit_samples (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    provider          TEXT    NOT NULL,
    plan              TEXT,
    used_5h_pct       REAL,
    used_weekly_pct   REAL,
    reset_5h_at       INTEGER,
    reset_weekly_at   INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_limit_samples_ts
     ON cost_limit_samples(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_limit_samples_provider
     ON cost_limit_samples(provider, ts)`,

  `CREATE TABLE IF NOT EXISTS cost_one_shot_calls (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    service        TEXT    NOT NULL,
    provider       TEXT    NOT NULL,
    command        TEXT    NOT NULL DEFAULT '',
    model          TEXT,
    cwd            TEXT,
    prompt         TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL DEFAULT 'unknown',
    exit_code      INTEGER,
    duration_ms    INTEGER,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    total_tokens   INTEGER NOT NULL DEFAULT 0,
    cost_usd       REAL    NOT NULL DEFAULT 0,
    metadata_json  TEXT    NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cost_one_shot_calls_ts
     ON cost_one_shot_calls(ts DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_one_shot_calls_service
     ON cost_one_shot_calls(service, ts DESC)`,
];

// 冪等 ALTER: 既存 DB に新規 column を後追いするための差分マイグレーション.
// CREATE TABLE IF NOT EXISTS は新規スキーマには効くが、 既存 DB の column 追加には効かない.
// 各エントリは PRAGMA table_info で存在チェックしてから ALTER する.
const COLUMN_ADDITIONS: Array<{ table: string; column: string; ddl: string }> = [
  {
    table: "cost_limit_samples",
    column: "plan",
    ddl: `ALTER TABLE cost_limit_samples ADD COLUMN plan TEXT`,
  },
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
  {
    table: "delegation_templates",
    column: "runtime_options_json",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN runtime_options_json TEXT NOT NULL DEFAULT '{}'`,
  },
  // delegation テンプレの絵文字 (モデル / 用途を視覚区別)。空文字 = フォールバック表示。
  {
    table: "delegation_templates",
    column: "emoji",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN emoji TEXT NOT NULL DEFAULT ''`,
  },
  // call_only=1 はプラットフォーム (Discord/Slack) の spawn ドロップダウンに出さない。
  // LLM 委託専用テンプレ (fix-bug / impl-from-design / refactor 等) に使う。
  {
    table: "delegation_templates",
    column: "call_only",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN call_only INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: "delegation_templates",
    column: "sort_order",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 1000`,
  },
  // ask マーカー / AskUserQuestion の複数選択フラグ + 複数選択回答の記録。
  {
    table: "discord_pending_questions",
    column: "multi_select",
    ddl: `ALTER TABLE discord_pending_questions ADD COLUMN multi_select INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: "discord_pending_questions",
    column: "answer_indices_json",
    ddl: `ALTER TABLE discord_pending_questions ADD COLUMN answer_indices_json TEXT`,
  },
  // チャンネル名の絵文字を Discord 側文字列パースに依存せず DB で管理する (three-out redesign)。
  // display_state = 表示状態 (working/active/lost/ended)、
  // agent_type = claude/codex/gemini 等 (絵文字選択用)、
  // name_body = チャンネル名のスラグ本体 (role or title slug)。
  {
    table: "discord_session_channels",
    column: "display_state",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN display_state TEXT NOT NULL DEFAULT 'active'`,
  },
  {
    table: "discord_session_channels",
    column: "agent_type",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN agent_type TEXT`,
  },
  {
    table: "discord_session_channels",
    column: "name_body",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN name_body TEXT`,
  },
  {
    table: "discord_session_channels",
    column: "delegation_emoji",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN delegation_emoji TEXT`,
  },
  // 子会社 Bot の per-guild namespacing。 '' = 本社、 'sub:<id>' = 子会社。
  // 複数 Discord bot が同一テーブルを共有しても listActive 等が混ざらないようにする。
  {
    table: "discord_session_channels",
    column: "scope",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN scope TEXT NOT NULL DEFAULT ''`,
  },
  // name_locked = /ch_name で固定したチャンネル名。 1 のとき title_renamed (reaction-rename
  // 含む) による name_body 上書きを抑止し、 ユーザ指定名を維持する (状態絵文字は更新可)。
  {
    table: "discord_session_channels",
    column: "name_locked",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN name_locked INTEGER NOT NULL DEFAULT 0`,
  },
  // Discord forum mode: channel_id は従来の text channel に加えて forum thread id を保持する。
  // 既存行はすべて channel として扱い、フラグ OFF の旧経路と完全互換にする。
  {
    table: "discord_session_channels",
    column: "channel_kind",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN channel_kind TEXT NOT NULL DEFAULT 'channel'`,
  },
  // 子会社の日次トークン予算 (0 = 無制限)。 子会社ごとにコスト上限を設け、 超過で受付を止める。
  {
    table: "subsidiaries",
    column: "daily_token_budget",
    ddl: `ALTER TABLE subsidiaries ADD COLUMN daily_token_budget INTEGER NOT NULL DEFAULT 0`,
  },
  // delegation の対象プロジェクト名 (cwd と別に持つ)。 グローバルテンプレ + 子会社所有の両方。
  {
    table: "delegation_templates",
    column: "project",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN project TEXT`,
  },
  // delegation の雇用形態カテゴリ (employee=従業員 / freelancer=フリーランサー / parttimer=パートタイマー)。
  // 既存行は employee で埋める (spawn がテンプレの既定用途のため)。 seed テンプレは boot upsert で正しい値に上書きされる。
  {
    table: "delegation_templates",
    column: "category",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'employee'`,
  },
  {
    table: "delegation_runs",
    column: "parent_session_id",
    ddl: `ALTER TABLE delegation_runs ADD COLUMN parent_session_id TEXT`,
  },
  {
    table: "delegation_runs",
    column: "child_session_id",
    ddl: `ALTER TABLE delegation_runs ADD COLUMN child_session_id TEXT`,
  },
  // subsidiary_delegations を薄い許可リスト → 子会社所有の複製定義へ拡張する差分 column 群。
  // 既存 (旧スキーマの) 行はデフォルト空で埋まり、 applyOwnedDelegationBackfill が
  // 同名グローバルテンプレから 1 回だけ複製内容を埋める。
  { table: "subsidiary_delegations", column: "title", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN title TEXT NOT NULL DEFAULT ''` },
  { table: "subsidiary_delegations", column: "description", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN description TEXT NOT NULL DEFAULT ''` },
  { table: "subsidiary_delegations", column: "target_provider", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN target_provider TEXT NOT NULL DEFAULT 'claude'` },
  { table: "subsidiary_delegations", column: "model", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN model TEXT` },
  { table: "subsidiary_delegations", column: "prompt_template", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN prompt_template TEXT NOT NULL DEFAULT ''` },
  { table: "subsidiary_delegations", column: "input_schema", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN input_schema TEXT NOT NULL DEFAULT '[]'` },
  { table: "subsidiary_delegations", column: "default_cwd", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN default_cwd TEXT` },
  { table: "subsidiary_delegations", column: "project", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN project TEXT` },
  { table: "subsidiary_delegations", column: "emoji", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN emoji TEXT NOT NULL DEFAULT ''` },
  { table: "subsidiary_delegations", column: "created_at", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0` },
  { table: "subsidiary_delegations", column: "updated_at", ddl: `ALTER TABLE subsidiary_delegations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0` },
  // ハーネス監査に操作対象リポ root を残す (max-repos の editedRepos をサーバ側で蓄積する状態源)。
  { table: "harness_session_audit", column: "repo", ddl: `ALTER TABLE harness_session_audit ADD COLUMN repo TEXT NOT NULL DEFAULT ''` },
  // 作業衝突スコープ: セッションが「実際に扱う個別プロジェクト」を宣言する列。
  // 未宣言なら repo_path、 repo_path がワークスペースルートなら衝突監視対象外 (conflict-scope.ts)。
  { table: "sessions", column: "target_project", ddl: `ALTER TABLE sessions ADD COLUMN target_project TEXT` },
  // 窓口の種別。 'subsidiary' = 別サーバへ出張する子会社 (専用 Bot を起動)、
  // 'desk' = 本社 Discord 内に依頼チャンネルを 1 本置くだけの軽量窓口 (Bot を起動しない)。
  // 既存行はすべて子会社なので DEFAULT 'subsidiary'。 spec/feature/subsidiary-delegation.md §9。
  {
    table: "subsidiaries",
    column: "mode",
    ddl: `ALTER TABLE subsidiaries ADD COLUMN mode TEXT NOT NULL DEFAULT 'subsidiary'`,
  },
  // 実行キュー待ち (status='queued') の run を後から spawn するための入力一式 (JSON)。
  // spawn 済み run では null。 spec/feature/delegation-coordination.md §6。
  {
    table: "delegation_runs",
    column: "queue_payload_json",
    ddl: `ALTER TABLE delegation_runs ADD COLUMN queue_payload_json TEXT`,
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

/**
 * 旧スキーマ (薄い許可リスト) の subsidiary_delegations 行を、 同名グローバルテンプレから
 * 複製内容で埋める 1 回限りのバックフィル。 prompt_template が空 (= 拡張 column を ALTER で
 * 後追いしただけの旧行) かつ同名テンプレが存在する行だけを対象にする (冪等)。 同名テンプレが
 * 無い旧行は空のまま残る (UI から手動で定義し直す)。
 */
function applyOwnedDelegationBackfill(db: Database.Database): void {
  // delegation_templates が無い (まだ作られていない) 環境では何もしない。
  const hasTemplates = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='delegation_templates'`)
    .get();
  if (!hasTemplates) return;
  const stale = db
    .prepare(`SELECT subsidiary_id, call_name FROM subsidiary_delegations WHERE prompt_template = ''`)
    .all() as Array<{ subsidiary_id: string; call_name: string }>;
  if (stale.length === 0) return;
  const findTpl = db.prepare(`SELECT * FROM delegation_templates WHERE call_name = ?`);
  const upd = db.prepare(`
    UPDATE subsidiary_delegations SET
      title = ?, description = ?, target_provider = ?, model = ?,
      prompt_template = ?, input_schema = ?, default_cwd = ?, project = ?, emoji = ?,
      created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END,
      updated_at = ?
    WHERE subsidiary_id = ? AND call_name = ?
  `);
  const now = 0; // 決定的な epoch (Date.now はスキーマ層で使わない)。表示用 timestamp は API/repo 側で付く。
  const tx = db.transaction(() => {
    for (const row of stale) {
      const tpl = findTpl.get(row.call_name) as
        | {
            title: string; description: string; target_provider: string; model: string | null;
            prompt_template: string; input_schema: string; default_cwd: string | null;
            project: string | null; emoji: string;
          }
        | undefined;
      if (!tpl) continue;
      upd.run(
        tpl.title, tpl.description, tpl.target_provider, tpl.model,
        tpl.prompt_template, tpl.input_schema, tpl.default_cwd, tpl.project ?? null, tpl.emoji,
        now, now, row.subsidiary_id, row.call_name,
      );
    }
  });
  tx();
}

/**
 * delegation_runs の parent_session_id / child_session_id は列追加 (applyColumnAdditions)
 * の後に index を張る。 base schema (STATEMENTS) で張ると既存 DB (列未追加) で
 * "no such column" になり起動失敗するため、 applyMigrations 内で列追加後に実行する。
 */
const DELEGATION_COORDINATION_INDEXES: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_parent_session
     ON delegation_runs(parent_session_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_child_session
     ON delegation_runs(child_session_id)`,
];

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 同一 DB ファイルを本体と cost-worker の 2 プロセスが開く (WAL でも writer は 1 つ)。
  // 競合時に即 SQLITE_BUSY で throw させず 5s まで待つことを明示する。 better-sqlite3 は
  // 同期 API なのでこの待ちはイベントループを塞ぐ — 値を大きくしすぎないこと。
  db.pragma("busy_timeout = 5000");
  if (shouldSkipMigrations(db)) return;
  const tx = db.transaction((stmts: string[]) => {
    for (const stmt of stmts) db.exec(stmt);
  });
  tx(STATEMENTS);
  applyColumnAdditions(db);
  // 列追加 (parent_session_id / child_session_id) の後に index を張る。 base schema で
  // 先に張ると既存 DB (列未追加) で "no such column" になり起動失敗するため。
  for (const stmt of DELEGATION_COORDINATION_INDEXES) db.exec(stmt);
  applyOwnedDelegationBackfill(db);
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta(key, value) VALUES('version', ?)`,
  ).run(String(SCHEMA_VERSION));
}

function shouldSkipMigrations(db: Database.Database): boolean {
  if (process.env.CONCORDIA_DB_SKIP_MIGRATIONS_IF_CURRENT === "0") return false;
  try {
    const row = db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
      .get() as { value?: unknown } | undefined;
    return String(row?.value ?? "") === String(SCHEMA_VERSION);
  } catch {
    return false;
  }
}
