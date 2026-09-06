/**
 * Concordia SQLite schema. spec/service-schema.md §2 に準拠.
 */

import type Database from "better-sqlite3";
import { runMigrations, type NumberedMigration } from "./migrator.js";
import { TASK_MD_CONTENT_RULE, TASK_STATE_DB_RULE } from "../taskflow/task-instructions.js";

export const SCHEMA_VERSION = 94;

/**
 * Migration 91's shipped backfill policy. Keep this local and immutable: the runtime
 * default in domain-review-seed.ts may evolve for newly registered projects, but an
 * installation date must never change what an already numbered migration writes.
 */
const MIGRATION_91_DOMAIN_REVIEW_OWNERS: ReadonlySet<string> = new Set(["ludiars", "melpot"]);
const MIGRATION_91_NON_PRODUCT_PROJECTS: ReadonlySet<string> = new Set([
  "ars",
  "castra",
  "ludiars",
  "infra",
  "aiformat",
  "all-in-onetest",
]);

/** @implements spec/feature/domain-review-discord.md §1 — migration 91 one-time seed */
function seedDomainReviewMigration91(project: string, repoOrigin: string | null): boolean {
  const value = repoOrigin?.trim();
  if (!value) return false;
  const match = /^(?:(?:https?:\/\/github\.com\/|git@github\.com:))?([A-Za-z0-9_.-]+)\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/i
    .exec(value);
  const owner = match?.[1]?.toLowerCase();
  return Boolean(owner && MIGRATION_91_DOMAIN_REVIEW_OWNERS.has(owner))
    && !MIGRATION_91_NON_PRODUCT_PROJECTS.has(project.trim().toLowerCase());
}

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

  // ─── managed processes (v0.2) ────────────────────────
  // Concordia が spawn / 監視するシェルプロセス. dev-process.md 由来 + API 直叩き.
  `CREATE TABLE IF NOT EXISTS processes (
    name         TEXT PRIMARY KEY,                  -- 識別名 (UNIQUE)
    cwd          TEXT NOT NULL,                     -- 絶対 cwd
    command      TEXT NOT NULL,                     -- shell 行
    repo_path    TEXT,                              -- 紐付く repo (dev-process.md の場所)
    repo_origin  TEXT,
    pid          INTEGER,                           -- 走行中のみ非 NULL
    instance_id  TEXT,                              -- spawn ごとの不変 ownership id
    generation   INTEGER NOT NULL DEFAULT 0,        -- 同名再起動ごとの単調増加世代
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
  //   webhook_id/token: 投稿用 webhook (表示名で per-message 上書き).
  `CREATE TABLE IF NOT EXISTS discord_session_channels (
    session_id      TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    channel_kind    TEXT NOT NULL DEFAULT 'channel',
    surface_message_id TEXT,
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
    forum_tag         INTEGER NOT NULL DEFAULT 0,
    category          TEXT    NOT NULL DEFAULT 'employee',  -- employee | freelancer | parttimer | test-qa (delegation-repo.ts DELEGATION_CATEGORIES が正本)
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
    effort_level        TEXT,
    effort_source       TEXT,
    effort_bucket       TEXT,
    effective_model     TEXT,
    fast_mode           INTEGER NOT NULL DEFAULT 0,
    spawn_cwd           TEXT,
    spawn_branch        TEXT,
    spawn_worktree_path TEXT,
    spawn_worktree_created INTEGER NOT NULL DEFAULT 0,
    effort_decision_id  INTEGER,
    finished_at         INTEGER,
    queue_payload_json  TEXT,
    queue_owner         TEXT,
    queue_lease_until   INTEGER,
    queue_fencing_token INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_created
     ON delegation_runs(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_triggered_by
     ON delegation_runs(triggered_by)`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_call_name
     ON delegation_runs(call_name, created_at DESC)`,
  // 実行キュー: queued を FIFO で拾い、 spawned/running のスロット数を数える経路が使う。
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_status
     ON delegation_runs(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS delegation_outbox (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL,
    kind          TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    owner         TEXT,
    fencing_token INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    delivered_at INTEGER,
    UNIQUE(run_id, kind),
    FOREIGN KEY(run_id) REFERENCES delegation_runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_delegation_outbox_pending
     ON delegation_outbox(status, created_at)`,
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
    start_approved_by TEXT,                      -- develop 起動を承認した principal
    promotion_approved_by TEXT,                  -- main 昇格を承認した別 principal
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
    persona_id         TEXT,                          -- 旧 persona 機構の遺構 (常に NULL。SQLite 列 drop 回避のため残置)
    persona_name       TEXT,                          -- 同上
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

  // ─── Slack platform (legacy thread mapping; rollback/history compatibility) ──
  // 新規 routing は slack_session_channels を正本とする。旧 thread 行は drop せず保持する。
  `CREATE TABLE IF NOT EXISTS slack_session_threads (
    session_id   TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL,
    thread_ts    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',  -- active | ended
    ts           INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_slack_session_threads_thread
     ON slack_session_threads(channel_id, thread_ts)`,

  // 公開 Bot-only session channel の正本。channel_id から ingress を逆引きし、
  // header card と終了後 archive の時刻を永続化する。
  `CREATE TABLE IF NOT EXISTS slack_session_channels (
    session_id      TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL UNIQUE,
    channel_name    TEXT NOT NULL,
    header_ts       TEXT,
    created_at      INTEGER NOT NULL,
    archive_due_at INTEGER,
    archived_at    INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_slack_session_channels_archive_due
     ON slack_session_channels(archive_due_at, archived_at)`,

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

  // Revisor 連携設定の key/value (discord_config / slack_config と対の構成)。
  // このテーブルが唯一の正本。env (旧 CONCORDIA_REVISOR_*) は読まない。
  // ★ workflow token は secret-box で暗号化した値を workflow_token_enc に保存し、
  //   平文では持たない (AIFormat §7 / coding-conventions §14)。
  `CREATE TABLE IF NOT EXISTS revisor_config (
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

  // API / core process から重い OS 制御を切り離す durable queue。
  // running lease が失効したジョブは別 control-worker が再取得できる。
  `CREATE TABLE IF NOT EXISTS control_jobs (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    payload_json     TEXT NOT NULL,
    dedupe_key       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    available_at     INTEGER NOT NULL,
    lease_owner      TEXT,
    lease_expires_at INTEGER,
    result_json      TEXT,
    last_error       TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    finished_at      INTEGER,
    expires_at       INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_control_jobs_claim
     ON control_jobs(status, available_at, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_control_jobs_active_dedupe
     ON control_jobs(dedupe_key)
     WHERE status IN ('queued', 'running')`,

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

  // kind 別 Inject マニュアル。 delegation invoke の協調コンテキストへ差し込む
  // 「作業マニュアル」を kind ごとに 1 行で持つ (WebUI /manuals から編集)。
  // kind 語彙 = 設計相談 | 実装 | レビュー | テスト | 雑用 (spec/feature/task-workflow.md §2.1)。
  // boot 時に既定内容を冪等 seed する (既存行の content は上書きしない = ユーザ編集尊重)。
  `CREATE TABLE IF NOT EXISTS inject_manuals (
    kind        TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  )`,

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
  // Session forum の spawn-by-post で選択可能なテンプレ。Discord 反映は明示 sync のみ。
  {
    table: "delegation_templates",
    column: "forum_tag",
    ddl: `ALTER TABLE delegation_templates ADD COLUMN forum_tag INTEGER NOT NULL DEFAULT 0`,
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
  {
    table: "discord_session_channels",
    column: "surface_message_id",
    ddl: `ALTER TABLE discord_session_channels ADD COLUMN surface_message_id TEXT`,
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
  { table: "delegation_runs", column: "effort_level", ddl: `ALTER TABLE delegation_runs ADD COLUMN effort_level TEXT` },
  { table: "delegation_runs", column: "effort_source", ddl: `ALTER TABLE delegation_runs ADD COLUMN effort_source TEXT` },
  { table: "delegation_runs", column: "effort_bucket", ddl: `ALTER TABLE delegation_runs ADD COLUMN effort_bucket TEXT` },
  { table: "delegation_runs", column: "effective_model", ddl: `ALTER TABLE delegation_runs ADD COLUMN effective_model TEXT` },
  { table: "delegation_runs", column: "fast_mode", ddl: `ALTER TABLE delegation_runs ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0` },
  { table: "delegation_runs", column: "spawn_cwd", ddl: `ALTER TABLE delegation_runs ADD COLUMN spawn_cwd TEXT` },
  { table: "delegation_runs", column: "spawn_branch", ddl: `ALTER TABLE delegation_runs ADD COLUMN spawn_branch TEXT` },
  { table: "delegation_runs", column: "spawn_worktree_path", ddl: `ALTER TABLE delegation_runs ADD COLUMN spawn_worktree_path TEXT` },
  { table: "delegation_runs", column: "spawn_worktree_created", ddl: `ALTER TABLE delegation_runs ADD COLUMN spawn_worktree_created INTEGER NOT NULL DEFAULT 0` },
  { table: "delegation_runs", column: "effort_decision_id", ddl: `ALTER TABLE delegation_runs ADD COLUMN effort_decision_id INTEGER` },
  { table: "delegation_runs", column: "finished_at", ddl: `ALTER TABLE delegation_runs ADD COLUMN finished_at INTEGER` },
  { table: "confirm_runs", column: "start_approved_by", ddl: `ALTER TABLE confirm_runs ADD COLUMN start_approved_by TEXT` },
  { table: "confirm_runs", column: "promotion_approved_by", ddl: `ALTER TABLE confirm_runs ADD COLUMN promotion_approved_by TEXT` },
  { table: "processes", column: "instance_id", ddl: `ALTER TABLE processes ADD COLUMN instance_id TEXT` },
  { table: "processes", column: "generation", ddl: `ALTER TABLE processes ADD COLUMN generation INTEGER NOT NULL DEFAULT 0` },
  { table: "delegation_runs", column: "queue_owner", ddl: `ALTER TABLE delegation_runs ADD COLUMN queue_owner TEXT` },
  { table: "delegation_runs", column: "queue_lease_until", ddl: `ALTER TABLE delegation_runs ADD COLUMN queue_lease_until INTEGER` },
  { table: "delegation_runs", column: "queue_fencing_token", ddl: `ALTER TABLE delegation_runs ADD COLUMN queue_fencing_token INTEGER NOT NULL DEFAULT 0` },
  // 委託 run watchdog (30 分周期の進捗確認) の永続状態。 in-memory Map だと再起動で
  // 監視・抑止が外れるため DB に持つ。 時刻はいずれも epoch-ms (delegation_runs の他の
  // 時刻列と同じ)。 spec/tasks/2026-08-08-delegation-run-watchdog.md。
  { table: "delegation_runs", column: "watchdog_last_check_at", ddl: `ALTER TABLE delegation_runs ADD COLUMN watchdog_last_check_at INTEGER` },
  { table: "delegation_runs", column: "watchdog_nudge_count", ddl: `ALTER TABLE delegation_runs ADD COLUMN watchdog_nudge_count INTEGER NOT NULL DEFAULT 0` },
  { table: "delegation_runs", column: "watchdog_last_nudge_at", ddl: `ALTER TABLE delegation_runs ADD COLUMN watchdog_last_nudge_at INTEGER` },
  { table: "delegation_runs", column: "watchdog_escalated_at", ddl: `ALTER TABLE delegation_runs ADD COLUMN watchdog_escalated_at INTEGER` },
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
  `CREATE INDEX IF NOT EXISTS idx_delegation_runs_effort_history
     ON delegation_runs(target_provider, effective_model, effort_bucket, status, created_at DESC)`,
];

export function applyMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 同一 DB ファイルを本体と cost-worker の 2 プロセスが開く (WAL でも writer は 1 つ)。
  // 競合時に即 SQLITE_BUSY で throw させず 5s まで待つことを明示する。 better-sqlite3 は
  // 同期 API なのでこの待ちはイベントループを塞ぐ — 値を大きくしすぎないこと。
  db.pragma("busy_timeout = 5000");
  runMigrations(db, MIGRATIONS, SCHEMA_VERSION);
}

/**
 * 適用済みの内容を後から編集してはいけない (checksum 台帳が一致しなくなり、 次の
 * 再起動で起動不能になる)。 新しいテーブル / 列は必ず末尾に番号付き migration を
 * 足すこと。 `migration-ledger.ts` の凍結値がこの規律をテストで守る。
 */
export const MIGRATIONS: readonly NumberedMigration[] = [{
  version: 41,
  name: "baseline-v41",
  source: JSON.stringify({ statements: STATEMENTS, columns: COLUMN_ADDITIONS, indexes: DELEGATION_COORDINATION_INDEXES }),
  up(db) {
    for (const stmt of STATEMENTS) db.exec(stmt);
    applyColumnAdditions(db);
    for (const stmt of DELEGATION_COORDINATION_INDEXES) db.exec(stmt);
    applyOwnedDelegationBackfill(db);
  },
}, {
  version: 42,
  name: "test-forum-pr-head-surfaces",
  source: "pr_records.head_sha + discord_test_surfaces v1",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(pr_records)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "head_sha")) {
      db.exec("ALTER TABLE pr_records ADD COLUMN head_sha TEXT");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_test_surfaces (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        scope          TEXT NOT NULL DEFAULT '',
        repo_origin    TEXT NOT NULL,
        pr_number      INTEGER NOT NULL,
        head_sha       TEXT NOT NULL,
        worktree_path  TEXT,
        thread_id      TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'open',
        created_at     INTEGER NOT NULL,
        closed_at      INTEGER,
        close_reason   TEXT,
        UNIQUE(scope, repo_origin, pr_number, head_sha, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_discord_test_surfaces_open
        ON discord_test_surfaces(scope, status, repo_origin, pr_number);
    `);
  },
}, {
  version: 43,
  name: "federation-link-p1",
  source: "federation_sites + federation_outbox v1",
  up(db) {
    // マルチ拠点連合 (spec/plan/multi-site-federation.md) Phase 1。
    // 用語衝突の注意: 既存 subsidiaries (出張所 Bot) とは別概念なので federation_* を使う。
    db.exec(`
      CREATE TABLE IF NOT EXISTS federation_sites (
        site_id            TEXT PRIMARY KEY,
        name               TEXT,
        token_enc          TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'active',
        created_at         INTEGER NOT NULL,
        revoked_at         INTEGER,
        last_connected_at  INTEGER,
        last_seen_at       INTEGER,
        site_version       TEXT
      );
      CREATE TABLE IF NOT EXISTS federation_outbox (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id    TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_federation_outbox_site
        ON federation_outbox(site_id, seq);
    `);
  },
}, {
  version: 44,
  name: "staff-roster-permissions",
  source: "staff_members v1 + reaction allowlist migration",
  up(db) {
    // 社員名簿 = 役職権限登録リスト。 LLM に触れた platform ユーザを記録し、 役職で
    // 権限を決める (spec/feature/staff-roster.md)。 リアクションWF 側の allowlist を
    // 廃してここを唯一の判定源にする。
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_members (
        platform         TEXT    NOT NULL,               -- discord | slack
        platform_user_id TEXT    NOT NULL,
        display_name     TEXT    NOT NULL DEFAULT '',    -- global name / username
        profile_name     TEXT    NOT NULL DEFAULT '',    -- サーバーでのプロファイル名
        role             TEXT    NOT NULL DEFAULT 'staff', -- staff | manager | executive
        note             TEXT    NOT NULL DEFAULT '',
        first_seen_at    INTEGER NOT NULL,
        last_seen_at     INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        PRIMARY KEY (platform, platform_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_staff_members_role
        ON staff_members(role, last_seen_at DESC);
    `);
    migrateReactionAllowlistToStaff(db);
  },
}, {
  version: 45,
  name: "federation-site-departments-p2",
  source: "federation_sites.departments JSON guild id array",
  up(db) {
    // 拠点ごとに設定を渡せる部署を固定し、担当外 guild の設定漏洩を防ぐ。
    db.exec("ALTER TABLE federation_sites ADD COLUMN departments TEXT NOT NULL DEFAULT '[]'");
  },
}, {
  version: 46,
  name: "federation-site-villa-pc",
  source: "federation_sites.villa_pc_id",
  up(db) {
    // PC 名ではなく Villa の安定した id を保持し、名称変更で拠点の対応を失わないようにする。
    db.exec("ALTER TABLE federation_sites ADD COLUMN villa_pc_id TEXT");
  },
}, {
  version: 47,
  name: "revisor-config",
  source: "revisor_config key/value",
  up(db) {
    // Revisor workflow token を Discord/Slack の bot token と同じ扱い (暗号化して DB) にする。
    // 既存 DB は baseline を通らないので、 ここで作らないとテーブルが生えない。
    db.exec(`
      CREATE TABLE IF NOT EXISTS revisor_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  },
}, {
  version: 48,
  name: "test-forum-content-hash-qa-run",
  source: "discord_test_surfaces.content_hash + qa_run_id",
  up(db) {
    // 投稿は作り直しではなく編集でリフレッシュする。 描画元データの指紋を持たないと
    // 「変わったか」を判定できず、 毎周期 Discord へ edit を投げて rate limit を食う。
    db.exec("ALTER TABLE discord_test_surfaces ADD COLUMN content_hash TEXT");
    // 投稿ごとに起動するテスト・QA セッションの delegation run。 マージ等で投稿を
    // 閉じるとき、 この run の child session も一緒に終わらせる (テスト・QA 3-1)。
    db.exec("ALTER TABLE discord_test_surfaces ADD COLUMN qa_run_id TEXT");
  },
}, {
  version: 49,
  name: "test-surface-controls",
  source: "discord_test_surfaces run state + spawn config",
  up(db) {
    // テストフォーラム投稿の操作面 (テスト開始 → マージ) の状態と実行設定。
    // run_state: candidate (未着手) | testing (セッション起動済み) | merged。
    // provider/model/effort は「テスト開始」前に投稿上のセレクトで変えられる値で、
    // 起動時にそのまま spawn へ渡る (spec/feature/test-forum-controls.md)。
    for (const [column, ddl] of [
      ["run_state", "run_state TEXT NOT NULL DEFAULT 'candidate'"],
      ["provider", "provider TEXT NOT NULL DEFAULT 'codex'"],
      ["model", "model TEXT NOT NULL DEFAULT 'sol'"],
      ["effort", "effort TEXT NOT NULL DEFAULT 'xhigh'"],
      ["session_id", "session_id TEXT"],
      ["local_pr_id", "local_pr_id TEXT"],
      ["controls_message_id", "controls_message_id TEXT"],
    ] as const) {
      const columns = db.prepare("PRAGMA table_info(discord_test_surfaces)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE discord_test_surfaces ADD COLUMN ${ddl}`);
      }
    }
  },
}, {
  version: 50,
  name: "test-surface-spawn-target",
  source: "discord_test_surfaces repository root + reviewed head branch",
  up(db) {
    // Revisor の登録済み repository root と local PR head ref を保持し、テスト開始時は
    // Concordia の既存 spawn-target 経路に branch + worktree=true で解決させる。
    for (const [column, ddl] of [
      ["repo_root_path", "repo_root_path TEXT"],
      ["head_branch", "head_branch TEXT"],
    ] as const) {
      const columns = db.prepare("PRAGMA table_info(discord_test_surfaces)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE discord_test_surfaces ADD COLUMN ${ddl}`);
      }
    }
  },
}, {
  version: 51,
  name: "test-surface-check-status",
  source: "discord_test_surfaces.check_status",
  up(db) {
    // 掲載を Test OK 限定から open 全件へ広げたので、 審査の決着遷移 (通過/失敗/
    // 判断待ち) を検知してスレッドへ知らせるために前回の checkStatus を持つ。
    db.exec("ALTER TABLE discord_test_surfaces ADD COLUMN check_status TEXT");
  },
}, {
  version: 52,
  name: "inquiry-protocol",
  source: "sessions.active_repos + delegation supervisor columns",
  up(db) {
    // お伺いプロトコル (spec/feature/inquiry.md §4) の上長解決と、 投稿タイトルの
    // 全プロジェクトコード (session-surface-project-codes.md) の保存先。
    // baseline (STATEMENTS / COLUMN_ADDITIONS) は適用済み DB の checksum 台帳に
    // 含まれるため事後編集できない — 新しい列は必ず番号付き migration で足す。
    for (const [table, column, ddl] of [
      ["sessions", "active_repos", "ALTER TABLE sessions ADD COLUMN active_repos TEXT NOT NULL DEFAULT '[]'"],
      ["delegation_runs", "supervisor_platform", "ALTER TABLE delegation_runs ADD COLUMN supervisor_platform TEXT"],
      ["delegation_runs", "supervisor_user_id", "ALTER TABLE delegation_runs ADD COLUMN supervisor_user_id TEXT"],
      ["delegation_templates", "supervisor_platform", "ALTER TABLE delegation_templates ADD COLUMN supervisor_platform TEXT"],
      ["delegation_templates", "supervisor_user_id", "ALTER TABLE delegation_templates ADD COLUMN supervisor_user_id TEXT"],
    ] as const) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) {
        db.exec(ddl);
      }
    }
  },
}, {
  version: 53,
  name: "session-message-layer-d1",
  source: "session_messages + session_message_delivery + session_message_reads v1",
  up(db) {
    // セッションメッセージ層 (spec/feature/session-message-layer.md §3)。 Discord egress
    // と WebUI が同じレコードを読む正本。 transcript_logs (raw frame) は残し、
    // こちらは projector が作る「表示用に整形済みの 1 メッセージ」を持つ。
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      TEXT NOT NULL,
        ts              INTEGER NOT NULL,
        edited_ts       INTEGER,
        author_type     TEXT NOT NULL,
        author_label    TEXT NOT NULL,
        author_platform TEXT,
        content         TEXT NOT NULL,
        embeds          TEXT,
        components      TEXT,
        attachments     TEXT,
        reference_id    INTEGER,
        metadata        TEXT,
        dedupe_key      TEXT,
        UNIQUE(session_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_id_desc
        ON session_messages(session_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session_ts_desc
        ON session_messages(session_id, ts DESC);
    `);
    // 配送先ごとの外部 ID。 D6 (Discord egress 切替) で編集・削除の伝播に使う。
    // D1 では作るだけで書き手は無い。
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_message_delivery (
        message_id  INTEGER NOT NULL,
        platform    TEXT NOT NULL,
        external_id TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        PRIMARY KEY (message_id, platform)
      )
    `);
    // client_id (ブラウザ生成 UUID) ごとの既読位置。 session_id ごとに 1 行。
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_message_reads (
        client_id    TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        last_read_id INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (client_id, session_id)
      )
    `);
  },
}, {
  version: 54,
  name: "taskflow-runtime-state",
  source: "taskflow_task_state v1",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS taskflow_task_state (
        repo_path                    TEXT NOT NULL,
        task_path                    TEXT NOT NULL,
        status                       TEXT NOT NULL DEFAULT 'pending',
        source_session               TEXT,
        assignee                     TEXT,
        owner                        TEXT,
        delegation_run_id            TEXT,
        pr_number                    INTEGER,
        memoria_task_id              TEXT,
        actio_task_id                TEXT,
        memoria_registration_state   TEXT NOT NULL DEFAULT 'idle',
        updated_at                   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo_path, task_path)
      );
      CREATE INDEX IF NOT EXISTS idx_taskflow_task_state_status
        ON taskflow_task_state(status, updated_at DESC);
    `);
  },
}, {
  version: 55,
  name: "discord-pending-question-channel",
  source: "discord_pending_questions.discord_channel_id",
  up(db) {
    // 質問カードを実際に投稿したチャンネル。委託子の面が無い/非アクティブのときは親
    // (委託元) の面へフォールバック投稿するため、解決時のボタン除去は子の面ではなく
    // この値で辿る。適用済み baseline-v41 の checksum を変えないよう番号付き migration にする。
    const columns = db.prepare("PRAGMA table_info(discord_pending_questions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "discord_channel_id")) {
      db.exec("ALTER TABLE discord_pending_questions ADD COLUMN discord_channel_id TEXT");
    }
  },
}, {
  version: 56,
  name: "director-script-flow",
  source: "director_cases + director_steps + director_decisions v1",
  up(db) {
    // Director は既存の task Markdown / delegation run / local PR / confirm run を複製せず、
    // 原稿フロー上の関連と工程状態だけを保持する。判断本文は Genius の監査結果として保存する。
    db.exec(`
      CREATE TABLE IF NOT EXISTS director_cases (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        goal        TEXT NOT NULL,
        project     TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS director_steps (
        id                  TEXT PRIMARY KEY,
        case_id             TEXT NOT NULL,
        sequence            INTEGER NOT NULL,
        kind                TEXT NOT NULL,
        title               TEXT NOT NULL,
        status              TEXT NOT NULL,
        task_path           TEXT,
        delegation_run_id   TEXT,
        local_pr_id         TEXT,
        confirm_run_id      TEXT,
        handoff_note        TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE(case_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_director_steps_case_sequence
        ON director_steps(case_id, sequence);
      CREATE TABLE IF NOT EXISTS director_decisions (
        id                TEXT PRIMARY KEY,
        case_id           TEXT NOT NULL,
        step_id           TEXT NOT NULL,
        kind              TEXT NOT NULL,
        question          TEXT NOT NULL,
        facts_json        TEXT NOT NULL,
        options_json      TEXT NOT NULL,
        impact            TEXT NOT NULL,
        decision          TEXT NOT NULL,
        instruction       TEXT NOT NULL,
        genius_available  INTEGER NOT NULL,
        genius_cards_json TEXT NOT NULL,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_director_decisions_case_created
        ON director_decisions(case_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_director_decisions_step_created
        ON director_decisions(step_id, created_at ASC);
    `);
  },
}, {
  version: 57,
  name: "director-decision-audit-order",
  source: "director_decisions audit_sequence v2 + redundant index cleanup",
  up(db) {
    // Migration 56 は既に配布済みなので編集しない。SQLite は AUTOINCREMENT の
    // PRIMARY KEY を ALTER TABLE で追加できないため、既存判断を発生順へ写して再構築する。
    // 同一時刻の旧データは rowid (= 挿入順) で安定化し、新規データは audit_sequence を使う。
    db.exec(`
      DROP INDEX IF EXISTS idx_director_decisions_case_created;
      DROP INDEX IF EXISTS idx_director_decisions_step_created;
      CREATE TABLE director_decisions_v57 (
        audit_sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
        id                TEXT NOT NULL UNIQUE,
        case_id           TEXT NOT NULL,
        step_id           TEXT NOT NULL,
        kind              TEXT NOT NULL,
        question          TEXT NOT NULL,
        facts_json        TEXT NOT NULL,
        options_json      TEXT NOT NULL,
        impact            TEXT NOT NULL,
        decision          TEXT NOT NULL,
        instruction       TEXT NOT NULL,
        genius_available  INTEGER NOT NULL,
        genius_cards_json TEXT NOT NULL,
        created_at        INTEGER NOT NULL
      );
      INSERT INTO director_decisions_v57(
        id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
        instruction, genius_available, genius_cards_json, created_at
      )
      SELECT
        id, case_id, step_id, kind, question, facts_json, options_json, impact, decision,
        instruction, genius_available, genius_cards_json, created_at
      FROM director_decisions
      ORDER BY created_at ASC, rowid ASC;
      DROP TABLE director_decisions;
      ALTER TABLE director_decisions_v57 RENAME TO director_decisions;
      CREATE INDEX idx_director_decisions_case_sequence
        ON director_decisions(case_id, audit_sequence ASC);
      CREATE INDEX idx_director_decisions_step_sequence
        ON director_decisions(step_id, audit_sequence ASC);
      DROP INDEX IF EXISTS idx_director_steps_case_sequence;
    `);
  },
}, {
  version: 58,
  name: "web-push-subscriptions",
  source: "web_push_config + web_push_subscriptions v1",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_push_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        endpoint TEXT PRIMARY KEY, client_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0, disabled_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_client ON web_push_subscriptions(client_id, disabled_at);
    `);
  },
}, {
  version: 60,
  name: "taskflow-runtime-state-constraints",
  source: "taskflow_task_state v2 status/PR/Memoria constraints",
  up(db) {
    // Migration 54 is already applied in deployed databases. Rebuild rather than edit it so
    // the migration ledger remains valid and existing rows gain the new invariants.
    db.exec(`
      CREATE TABLE taskflow_task_state_v60 (
        repo_path                    TEXT NOT NULL,
        task_path                    TEXT NOT NULL,
        status                       TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'delegated', 'done', 'cancelled')),
        source_session               TEXT,
        assignee                     TEXT,
        owner                        TEXT,
        delegation_run_id            TEXT,
        pr_number                    INTEGER
          CHECK (pr_number IS NULL OR (typeof(pr_number) = 'integer' AND pr_number > 0)),
        memoria_task_id              TEXT,
        actio_task_id                TEXT,
        memoria_registration_state   TEXT NOT NULL DEFAULT 'idle'
          CHECK (memoria_registration_state IN ('idle', 'creating', 'created')),
        updated_at                   INTEGER NOT NULL DEFAULT 0,
        CHECK ((memoria_registration_state = 'created') = (memoria_task_id IS NOT NULL)),
        PRIMARY KEY (repo_path, task_path)
      );
      INSERT INTO taskflow_task_state_v60(
        repo_path, task_path, status, source_session, assignee, owner, delegation_run_id,
        pr_number, memoria_task_id, actio_task_id, memoria_registration_state, updated_at
      )
      SELECT
        repo_path,
        task_path,
        CASE WHEN status IN ('pending', 'delegated', 'done', 'cancelled') THEN status ELSE 'pending' END,
        source_session,
        assignee,
        owner,
        delegation_run_id,
        CASE WHEN typeof(pr_number) = 'integer' AND pr_number > 0 THEN pr_number ELSE NULL END,
        memoria_task_id,
        actio_task_id,
        CASE
          WHEN memoria_task_id IS NOT NULL THEN 'created'
          WHEN memoria_registration_state = 'creating' THEN 'creating'
          ELSE 'idle'
        END,
        updated_at
      FROM taskflow_task_state;
      DROP TABLE taskflow_task_state;
      ALTER TABLE taskflow_task_state_v60 RENAME TO taskflow_task_state;
      CREATE INDEX idx_taskflow_task_state_status
        ON taskflow_task_state(status, updated_at DESC);
    `);
  },
}, {
  version: 59,
  name: "taskflow-inject-state-in-db",
  source: "harness_rules / inject_manuals — task md 書き戻しの禁止",
  up(db) {
    // seed は既存行を上書きしない。既定文言のままの行だけを更新して、
    // Web UI で個別編集された運用ルールは変更しない。
    const replace = (sql: string, next: string, previous: string): void => {
      db.prepare(sql).run(next, previous);
    };
    replace(
      `UPDATE harness_rules SET description = ?, updated_at = strftime('%s','now') * 1000
         WHERE builtin = 1 AND title = '実装前の task md 分解を必須化' AND description = ?`,
      `実装タスクは着手前に分解保存してから作業する。${TASK_MD_CONTENT_RULE}${TASK_STATE_DB_RULE}`,
      "実装タスクは着手前に対象リポの spec/tasks/ へ md で分解保存してから作業する。md がタスクの正本である。",
    );
    replace(
      `UPDATE harness_rules SET description = ?, updated_at = strftime('%s','now') * 1000
         WHERE builtin = 1 AND title = '作業ブランチ + worktree 必須' AND description = ?`,
      "実装作業は main / develop の直編集・直コミットで行わない。作業内容を解析して作業ブランチを確定し、" +
      "ワークツリーを生成してから作業する。作業完了はタスクワークフロー (spec/tasks/ への新規保存) に積み、コミット → PR 作成まで行う。" +
      "PR 作成後は停止し、ユーザの明示指示がないレビュー・テスト・マージへ進まない。" +
      "ルートフォルダ (リポ本体) のブランチ切り替え自体は判定対象にしない (不問)。" +
      "判定するのは main/develop への直コミットと、完了フロー (タスク分解 → コミット → PR) の欠落である。",
      "実装作業は main / develop の直編集・直コミットで行わない。作業内容を解析して作業ブランチを確定し、" +
      "ワークツリーを生成してから作業する。作業完了はタスクワークフロー (task md) に積み、コミット → PR 作成まで行う。" +
      "PR 作成後は停止し、ユーザの明示指示がないレビュー・テスト・マージへ進まない。" +
      "ルートフォルダ (リポ本体) のブランチ切り替え自体は判定対象にしない (不問)。" +
      "判定するのは main/develop への直コミットと、完了フロー (task md → コミット → PR) の欠落である。",
    );
    replace(
      `UPDATE inject_manuals SET content = ?, updated_at = strftime('%s','now') * 1000
         WHERE kind = '実装' AND content = ?`,
      "作業ブランチを確定 → worktree を生成 → 作業 → タスクを spec/tasks/ に新規保存で分解 → コミット → PR 作成まで行う。" +
      "進行状態 (status / 担当 / PR 番号 / 外部タスク ID) は Concordia の DB が正本なので、既存 task md へ書き戻さない。" +
      "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。",
      "作業ブランチを確定 → worktree を生成 → 作業 → task md (spec/tasks/) に分解 → コミット → PR 作成まで行う。" +
      "main/develop へ直コミットしない。PR 作成後は停止する。ユーザの明示指示がないテスト・マージ・オートマージは禁止。",
    );
  },
}, {
  // This migration was originally numbered 60 on a parallel branch, which
  // collided with taskflow-runtime-state-constraints and prevented every DB
  // backed test from starting. That earlier migration is already deployed, so
  // leave it immutable and assign this later migration 61 instead.
  version: 61,
  name: "taskflow-task-state-slug",
  source: "taskflow_task_state.task_slug",
  up(db) {
    // task md の rename / 移動で state 行が孤児化し、 同じタスクが Memoria へ二重登録される
    // のを防ぐための引き継ぎキー。 (repo_path, task_path) だけでは移動を追えない。
    const columns = db.prepare("PRAGMA table_info(taskflow_task_state)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "task_slug")) {
      db.exec("ALTER TABLE taskflow_task_state ADD COLUMN task_slug TEXT");
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_taskflow_task_state_slug
               ON taskflow_task_state(repo_path, task_slug)`);
  },
}, {
  version: 62,
  name: "delegation-staged-injection",
  source: "delegation_runs staged injection columns v1",
  up(db) {
    // 段階注入 (実装委託の 初回=調査ブリーフ / 後追い=実装タスク) の永続状態。
    // 二重配信の抑止と Memoria タスクの関連付けは、 Cc の再起動をまたいでも外れては
    // ならないので in-memory ではなく列に持つ (run-watchdog の watchdog_* と同方針)。
    // COLUMN_ADDITIONS (baseline-v41) には足さない — 適用済み migration の source を
    // 変えると checksum mismatch で Cc が起動しなくなるため、 forward-only で足す。
    // spec/feature/delegation-staged-injection.md。
    const columns = db.prepare("PRAGMA table_info(delegation_runs)").all() as Array<{ name: string }>;
    const has = (name: string): boolean => columns.some((column) => column.name === name);
    if (!has("staged_injection")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN staged_injection INTEGER NOT NULL DEFAULT 0");
    }
    if (!has("staged_followup_at")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN staged_followup_at INTEGER");
    }
    if (!has("investigation_summary")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN investigation_summary TEXT");
    }
    if (!has("memoria_task_id")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN memoria_task_id TEXT");
    }
    if (!has("memoria_task_url")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN memoria_task_url TEXT");
    }
  },
}, {
  version: 63,
  name: "director-plan-version",
  source: "director_decisions plan_version + plan_md_ref",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(director_decisions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "plan_version")) db.exec("ALTER TABLE director_decisions ADD COLUMN plan_version INTEGER");
    if (!columns.some((column) => column.name === "plan_md_ref")) db.exec("ALTER TABLE director_decisions ADD COLUMN plan_md_ref TEXT");
  },
}, {
  version: 64,
  name: "director-case-session",
  source: "director_cases.session_id nullable",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(director_cases)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "session_id")) db.exec("ALTER TABLE director_cases ADD COLUMN session_id TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_director_cases_session ON director_cases(session_id, updated_at DESC)");
  },
}, {
  version: 65,
  name: "teams-core",
  source: "teams + team_repos + nullable team ownership",
  up(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,settings_json TEXT NOT NULL DEFAULT '{}',rules_text TEXT NOT NULL DEFAULT '',discord_category_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS team_repos(team_id TEXT NOT NULL,repo_origin TEXT NOT NULL,PRIMARY KEY(team_id,repo_origin));
    CREATE INDEX IF NOT EXISTS idx_team_repos_origin ON team_repos(repo_origin);
    CREATE TABLE IF NOT EXISTS team_surfaces(team_id TEXT NOT NULL,surface TEXT NOT NULL,channel_id TEXT NOT NULL,PRIMARY KEY(team_id,surface));
    `);
    for (const table of ["sessions", "delegation_runs", "director_cases"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "team_id")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN team_id TEXT`);
      }
    }
  },
}, {
  version: 66,
  name: "harness-rules-team-scope",
  source: "harness_rules.team_id",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(harness_rules)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "team_id")) {
      db.exec("ALTER TABLE harness_rules ADD COLUMN team_id TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_harness_rules_team ON harness_rules(team_id,enabled,sort_order)");
  },
}, {
  version: 67,
  name: "team-audit-posts",
  source: "team_audit_posts dedupe table for team.created/team.changed audit cards",
  up(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS team_audit_posts(dedupe_key TEXT PRIMARY KEY,team_id TEXT NOT NULL,posted_at INTEGER NOT NULL);
    `);
  },
}, {
  version: 68,
  name: "director-ask-human-bundle",
  source: "director_decisions pending_question_id + human answer audit",
  up(db) {
    // ask_human 判断は discord_pending_questions のカード 1 枚に束ねて投稿される。
    // どのカードに載ったか (pending_question_id) と人間の回答を監査保存する。
    const columns = db.prepare("PRAGMA table_info(director_decisions)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "pending_question_id")) {
      db.exec("ALTER TABLE director_decisions ADD COLUMN pending_question_id INTEGER");
    }
    if (!columns.some((column) => column.name === "human_answer")) {
      db.exec("ALTER TABLE director_decisions ADD COLUMN human_answer TEXT");
    }
    if (!columns.some((column) => column.name === "human_answered_at")) {
      db.exec("ALTER TABLE director_decisions ADD COLUMN human_answered_at INTEGER");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_director_decisions_pending_question ON director_decisions(pending_question_id)");
  },
}, {
  version: 69,
  name: "director-case-stall-ticks",
  source: "director_cases stall_ticks for inquiry stall detection",
  up(db) {
    // 停滞判定 (spec/feature/director-inquiry-session.md §1) は「実行可能 step 無しが
    // N tick 継続」で決まる。プロセス内カウンタだと再起動のたびに 0 へ戻り、
    // 再起動が多い環境では閾値へ到達しない。case 側に持たせて跨がせる。
    const columns = db.prepare("PRAGMA table_info(director_cases)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "stall_ticks")) {
      db.exec("ALTER TABLE director_cases ADD COLUMN stall_ticks INTEGER NOT NULL DEFAULT 0");
    }
  },
}, {
  version: 70,
  name: "escalation-mode",
  source: "sessions.escalation_mode + escalation_events + pending_tasks.priority",
  up(db) {
    // エスカレーションモード (spec/feature/escalation-mode.md)。
    // 状態は sessions 行に、 監査は escalation_events に持つ。 作業停止 claim は
    // 既存 pending_tasks 経路へ載せるため、 キュー末尾に積まれないよう priority を足す。
    const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "escalation_mode")) {
      db.exec("ALTER TABLE sessions ADD COLUMN escalation_mode INTEGER NOT NULL DEFAULT 0");
    }
    const pendingColumns = db.prepare("PRAGMA table_info(pending_tasks)").all() as Array<{ name: string }>;
    if (!pendingColumns.some((column) => column.name === "priority")) {
      db.exec("ALTER TABLE pending_tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS escalation_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'api'
    );
    CREATE INDEX IF NOT EXISTS idx_escalation_events_session ON escalation_events(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_escalation_events_open ON escalation_events(ended_at, started_at DESC);
    `);
  },
}, {
  version: 71,
  name: "project-code-registry",
  source: "project_codes empty registry v1",
  up(db) {
    // Cc が唯一の正本。既存 Markdown や repository 一覧は seed せず、明示登録だけを保存する。
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_codes (
        code        TEXT PRIMARY KEY COLLATE BINARY,
        project     TEXT NOT NULL COLLATE NOCASE UNIQUE,
        repo_path   TEXT NOT NULL COLLATE NOCASE UNIQUE,
        repo_origin TEXT COLLATE NOCASE UNIQUE,
        added_by    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `);
  },
}, {
  version: 72,
  name: "cc-task-fallback",
  source: "Cc durable task fallback and Actio outbox",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cc_tasks (
        id TEXT PRIMARY KEY,
        source_key TEXT UNIQUE,
        title TEXT NOT NULL,
        details TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        kind TEXT NOT NULL DEFAULT 'task',
        creator_type TEXT NOT NULL DEFAULT 'human',
        category TEXT,
        due_at TEXT,
        actio_task_id TEXT,
        actio_sync_state TEXT NOT NULL DEFAULT 'pending',
        actio_sync_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cc_tasks_status ON cc_tasks(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cc_tasks_actio_sync ON cc_tasks(actio_sync_state, updated_at ASC);
    `);
  },
}, {
  version: 73,
  name: "delegation-sdk-safety-and-legacy-delete",
  source: "delete legacy global/subsidiary delegation definitions; null run template ids; codex templates to codex-sdk",
  up(db) {
    // 適用済み migration は編集できないため、旧 call_name の物理削除と provider の
    // 全件変換を独立 migration にする。run は denormalized call_name/provider を持つので、
    // template_id だけ NULL にして履歴を保持する。
    const legacyCallNames = [
      "gamma-impl",
      "claude-sonnet-4-6-impl",
      "claude-opus-4-8-impl",
      "daily-review-reconciliation",
      "ludiars-review-daily",
      "claude-fable-5-impl",
      "claude-fable-5-impl-2",
      "codex-5-5",
      "codex-5-5-2",
      "codex-5-6-sol-medium",
      "codex-5-6-sol",
      "codex-5-6-sol-2",
      "claude-opus-5-impl",
      "codex-5-6-sol-ultra",
      "claude-haiku-4-5-impl",
      "codex-5-6-luna",
      "claude-sonnet-5-impl",
      "codex-5-6-terra",
      "opus4-8",
      "review-sonnet5",
    ];
    const placeholders = legacyCallNames.map(() => "?").join(",");
    db.prepare(`
      UPDATE delegation_runs
      SET template_id = NULL
      WHERE template_id IN (
        SELECT id FROM delegation_templates WHERE call_name IN (${placeholders})
      )
    `).run(...legacyCallNames);
    db.prepare(`DELETE FROM delegation_templates WHERE call_name IN (${placeholders})`)
      .run(...legacyCallNames);
    db.prepare(`DELETE FROM subsidiary_delegations WHERE call_name IN (${placeholders})`)
      .run(...legacyCallNames);
    db.prepare(`UPDATE delegation_templates SET target_provider = 'codex-sdk' WHERE target_provider = 'codex'`).run();
    db.prepare(`UPDATE subsidiary_delegations SET target_provider = 'codex-sdk' WHERE target_provider = 'codex'`).run();
    // 待機中 run は新 service が payload を起動時に再正規化する。run record も実際に
    // 起動される provider と一致させ、過去の完了 run は監査履歴として変更しない。
    db.prepare(`
      UPDATE delegation_runs
      SET target_provider = 'codex-sdk'
      WHERE target_provider = 'codex' AND status IN ('queued', 'launching')
    `).run();
  },
}, {
  version: 74,
  name: "team-suspend",
  source: "teams.suspended_at — 作業していないチームの一時停止 (2026-08-27 neco 指示)",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "suspended_at")) {
      db.exec("ALTER TABLE teams ADD COLUMN suspended_at INTEGER");
    }
  },
},
{
  version: 75,
  name: "delegation-template-overrides",
  source: "platform/site scoped delegation template patches",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delegation_template_overrides (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES delegation_templates(id),
        scope_kind TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        patch_json TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(template_id, scope_kind, scope_key)
      );
      CREATE INDEX IF NOT EXISTS idx_delegation_template_overrides_active
        ON delegation_template_overrides(template_id, scope_kind, scope_key, is_active);
    `);
  },
}, {
  version: 76,
  name: "federation-site-platform",
  source: "record platform declared by each federation site handshake",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(federation_sites)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "platform")) {
      db.exec("ALTER TABLE federation_sites ADD COLUMN platform TEXT");
    }
  },
}, {
  version: 77,
  name: "subsidiary-taskflow-scope",
  source: "delegation_runs/taskflow_task_state subsidiary ownership + session/request backfill v1",
  up(db) {
    const runColumns = db.prepare("PRAGMA table_info(delegation_runs)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "subsidiary_id")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN subsidiary_id TEXT");
    }
    const taskColumns = db.prepare("PRAGMA table_info(taskflow_task_state)").all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "subsidiary_id")) {
      db.exec("ALTER TABLE taskflow_task_state ADD COLUMN subsidiary_id TEXT");
    }

    // 既存 run は child session の durable metadata から所有者を復元する。
    db.exec(`
      UPDATE delegation_runs
         SET subsidiary_id = COALESCE(
           (SELECT CASE WHEN json_valid(s.metadata) THEN
             CASE WHEN json_type(s.metadata, '$.subsidiary_id') = 'text'
               THEN NULLIF(trim(json_extract(s.metadata, '$.subsidiary_id')), '')
             END
           END FROM sessions s WHERE s.id = delegation_runs.child_session_id),
           (SELECT request.subsidiary_id
              FROM subsidiary_requests request
             WHERE request.run_id = delegation_runs.id
             ORDER BY request.created_at DESC
             LIMIT 1)
         )
       WHERE subsidiary_id IS NULL
         AND (child_session_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM subsidiary_requests request WHERE request.run_id = delegation_runs.id
         ));

      UPDATE taskflow_task_state
         SET subsidiary_id = COALESCE(
           (SELECT r.subsidiary_id FROM delegation_runs r WHERE r.id = taskflow_task_state.delegation_run_id),
           (SELECT CASE WHEN json_valid(s.metadata) THEN
             CASE WHEN json_type(s.metadata, '$.subsidiary_id') = 'text'
               THEN NULLIF(trim(json_extract(s.metadata, '$.subsidiary_id')), '')
             END
           END FROM sessions s WHERE s.id = taskflow_task_state.source_session)
         )
       WHERE subsidiary_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_delegation_runs_subsidiary_created
        ON delegation_runs(subsidiary_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_taskflow_task_state_subsidiary_status
        ON taskflow_task_state(subsidiary_id, status, updated_at DESC);
    `);
  },
}, {
  version: 78,
  name: "subsidiary-teams",
  source: "organization-owned teams + subsidiary default team",
  up(db) {
    const teamColumns = db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string }>;
    if (!teamColumns.some((column) => column.name === "subsidiary_id")) {
      db.exec("ALTER TABLE teams ADD COLUMN subsidiary_id TEXT");
    }
    const subsidiaryColumns = db.prepare("PRAGMA table_info(subsidiaries)").all() as Array<{ name: string }>;
    if (!subsidiaryColumns.some((column) => column.name === "default_team_id")) {
      db.exec("ALTER TABLE subsidiaries ADD COLUMN default_team_id TEXT");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_teams_subsidiary_name
        ON teams(subsidiary_id, name);
      CREATE INDEX IF NOT EXISTS idx_subsidiaries_default_team
        ON subsidiaries(default_team_id);
    `);
  },
}, {
  version: 79,
  name: "curiosity-walks",
  source: "curiosity walk records (spec/feature/curiosity-walk.md §4)",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS curiosity_walks (
        id            TEXT PRIMARY KEY,
        team_id       TEXT,
        subsidiary_id TEXT,
        repo_a        TEXT NOT NULL,
        repo_b        TEXT NOT NULL,
        material_a    TEXT NOT NULL,
        material_b    TEXT NOT NULL,
        combo_key     TEXT NOT NULL,
        run_id        TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_curiosity_walks_created
        ON curiosity_walks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_curiosity_walks_combo
        ON curiosity_walks(combo_key, created_at DESC);
    `);
  },
}, {
  // 79 は curiosity-walk 用に予約済みのまま、並行開発側が 80 を採番した。
  // 適用順と migration identity を保つため、この順序を維持する。
  version: 80,
  name: "session-events-ts-index",
  source: "sweeper purgeEventsOlderThan の毎分フルスキャン回避 (spec/plan/2026-09-01-cc-event-loop-diet.md)",
  up(db) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_ts ON session_events(ts)");
  },
}, {
  version: 81,
  name: "subsidiary-projects",
  source: "子会社が関係する project の明示集合 (Test forum の掲載範囲を絞る)",
  up(db) {
    // 子会社は本社の全 PR を見る必要が無い。 関係する project を WebUI から明示設定し、
    // Test forum の掲載をその集合だけに絞る (2026-09-01 neco 指示)。
    // project は project_codes.project と同じ表記 (= repo 名) を正本とする。
    db.exec(`
    CREATE TABLE IF NOT EXISTS subsidiary_projects(
      subsidiary_id TEXT NOT NULL,
      project       TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY(subsidiary_id, project)
    );
    CREATE INDEX IF NOT EXISTS idx_subsidiary_projects_project ON subsidiary_projects(project);
    `);
  },
}, {
  version: 82,
  name: "delegation-template-review-only",
  source: "レビュー専用テンプレを完了証跡ガードの対象外にする (Memoria #1858)",
  up(db) {
    // 完了証跡ガード (delegation/completion-evidence.ts) は「実装 run が feature branch を
    // 持たずに completed を自己申告する」穴を塞ぐために入った。 だが脆弱性対応やレビュー系の
    // テンプレはコードを書かない設計 (成果物は Review/ への保存) なので feature branch が
    // 無いのが正常で、 ガードに一律で落とされ completed を報告できなかった。
    //
    // 「branch が無ければ素通し」に緩めると塞いだ穴が open に戻るため、 テンプレ側に
    // 「このテンプレは実装しない」を明示宣言させ、 その run だけをガードの対象外にする。
    const columns = db.prepare("PRAGMA table_info(delegation_templates)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "review_only")) {
      db.exec("ALTER TABLE delegation_templates ADD COLUMN review_only INTEGER NOT NULL DEFAULT 0");
    }
    // 既定は 0 (= 実装テンプレ扱い) なので、 報告のあったテンプレだけ宣言を入れておく。
    // これを省くと列を足しただけで、 詰まっている脆弱性対応 run は救われない。
    // 他のレビュー系テンプレは、 テンプレごとの契約を見て運用側が設定面から立てる。
    db.prepare("UPDATE delegation_templates SET review_only = 1 WHERE call_name = ?")
      .run("vulnerability-response-daily");
  },
}, {
  version: 83,
  name: "parttimer-chore-manual",
  source: "inject_manuals(雑用) — パートタイマー inject の書き直し (spec/feature/delegation-parttimer-inject.md)",
  up(db) {
    // 雑用マニュアルはこれまで自動割り当ての対象外だったので、 既定文のままの行しか存在しない。
    // パートタイマーが 雑用 を受け取るようになったので、 既定文だった行だけを差し替える
    // (WebUI で編集済みの行は触らない = seed と同じ扱い)。
    db.prepare(
      `UPDATE inject_manuals SET content = ?, updated_at = strftime('%s','now') * 1000
         WHERE kind = '雑用' AND content = ?`,
    ).run(
      // Migration は適用後に不変でなければならない。 runtime の既定値定数を参照すると、
      // 将来その文言を編集しただけで過去 migration の結果まで変わるため、 v83 の値を固定する。
      "タスク本文に書かれた範囲だけを実行し、手順を足さない。" +
        "ファイルを変更する指示があるときだけ作業ブランチ → Revisor local PR にする (読み取り・報告だけなら git 操作は不要)。" +
        "サービスの起動・再起動は本文が指示した場合に限り、Excubitor 経由でプロジェクト本体フォルダから行う (worktree / 複製フォルダから起動しない)。" +
        "やることが無かった場合も、その事実を報告する。",
      "軽作業。リポ変更を伴うならブランチ → PR、読み取りのみなら自由。",
    );
  },
}, {
  version: 84,
  name: "delegation-run-category",
  source: "delegation_runs.category — 起動時 category を完了証跡判定用に固定 (spec/feature/delegation-parttimer-inject.md)",
  up(db) {
    const columns = db.prepare("PRAGMA table_info(delegation_runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "category")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN category TEXT");
    }
  },
}, {
  version: 85,
  name: "inbox-notice-state",
  source: "inbox_notice_state — ダイジェスト投稿と項目ごとの催促 cooldown (spec/feature/approval-inbox.md §3)",
  up(db) {
    // 再起動で消えると朝のダイジェストが二重に出たり、 12h cooldown が明けていない
    // 項目を再催促したりする。 in-memory では持てない。
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_notice_state (
        key      TEXT PRIMARY KEY,
        last_at  INTEGER NOT NULL
      );
    `);
  },
}, {
  version: 86,
  name: "inbox-item-state",
  source: "inbox_item_state — 承認インボックスの既読・スヌーズ (spec/feature/approval-inbox.md §2)",
  up(db) {
    // **UI 状態専用。** 回答や解決をこの表で表現しない — 正本は各項目の元テーブルで、
    // ここに書いても人が答えたことにはならない。 client_id はブラウザ生成 UUID で、
    // 既読は client ごと (session_message_reads と同じ方式)。
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_item_state (
        client_id      TEXT NOT NULL,
        item_key       TEXT NOT NULL,
        read_at        INTEGER,
        snoozed_until  INTEGER,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (client_id, item_key)
      );
    `);
  },
}, {
  version: 87,
  name: "director-case-status-card",
  source: "director_cases.status_card_{channel,message}_id — 工程遷移で目標面のカードを更新する (spec/feature/director-goal-flow.md 受け入れ基準 5)",
  up(db) {
    // カードを毎回新規投稿すると目標面が同じ内容で埋まる。 更新するには message id が要る。
    const columns = db.prepare("PRAGMA table_info(director_cases)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("status_card_channel_id")) {
      db.exec("ALTER TABLE director_cases ADD COLUMN status_card_channel_id TEXT");
    }
    if (!names.has("status_card_message_id")) {
      db.exec("ALTER TABLE director_cases ADD COLUMN status_card_message_id TEXT");
    }
  },
}, {
  version: 88,
  name: "delegation-spawn-worktree-state",
  source: "delegation_runs.spawn_worktree_state — worktree 解決の結果を 4 値で持つ (spec/feature/delegation-spawn-target-validation.md §2.3)",
  up(db) {
    // spawn_worktree_created の boolean では「作らなかった」が branch 未指定 / 既存再利用 /
    // 共有 checkout の 3 通りに潰れ、 事故と正常を機械的に区別できなかった (2026-09-05)。
    const columns = db.prepare("PRAGMA table_info(delegation_runs)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("spawn_worktree_state")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN spawn_worktree_state TEXT");
    }
  },
}, {
  version: 89,
  name: "github-issue-workflow",
  source: "github_issue_runs / github_event_deliveries / github_config / project_codes.github_issue_workflow (spec/feature/github-issue-workflow.md)",
  up(db) {
    // Issue 起点の自動修正は opt-in したプロジェクトだけで動かす。 既定 0 = 既存登録の挙動は不変。
    const columns = db.prepare("PRAGMA table_info(project_codes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "github_issue_workflow")) {
      db.exec("ALTER TABLE project_codes ADD COLUMN github_issue_workflow INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_issue_runs (
        id                TEXT PRIMARY KEY,
        repo_origin       TEXT NOT NULL COLLATE NOCASE,
        issue_number      INTEGER NOT NULL,
        issue_title       TEXT NOT NULL,
        issue_url         TEXT NOT NULL,
        label             TEXT NOT NULL,
        actor             TEXT NOT NULL,
        project_code      TEXT,
        repo_path         TEXT NOT NULL,
        branch            TEXT NOT NULL,
        status            TEXT NOT NULL,
        delegation_run_id TEXT,
        local_pr_id       TEXT,
        github_pr_url     TEXT,
        detail            TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      -- 1 Issue 1 run。 webhook とポーリングの二重受信で 2 本起動しないための一意制約。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_runs_issue
        ON github_issue_runs(repo_origin, issue_number, label);
      CREATE INDEX IF NOT EXISTS idx_github_issue_runs_status
        ON github_issue_runs(status);
      -- webhook は同じ delivery を再送する。 処理済み id を持って二重処理を止める。
      CREATE TABLE IF NOT EXISTS github_event_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event       TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      -- webhook secret 置き場 (revisor_config と同型の key/value + secret-box 暗号化)。
      CREATE TABLE IF NOT EXISTS github_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
}, {
  version: 90,
  name: "github-issue-run-author",
  source: "github_issue_runs.issue_author — 妥当性チェックを起票者とラベル付与者の両方で行う (spec/feature/github-issue-workflow.md)",
  up(db) {
    // ラベルを付けた人だけを見ると、 信頼できる起票者の Issue に第三者がラベルを付けた
    // ケースと、 その逆を区別できない。 承認の判断材料として両方を残す (2026-09-05 neco 指示)。
    const columns = db.prepare("PRAGMA table_info(github_issue_runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "issue_author")) {
      db.exec("ALTER TABLE github_issue_runs ADD COLUMN issue_author TEXT NOT NULL DEFAULT ''");
    }
  },
}, {
  version: 91,
  name: "project-code-domain-review",
  source: "project_codes.domain_review — ドメインレビューを Discord へ出すか (spec/feature/domain-review-discord.md §1)",
  up(db) {
    // 列を追加した回だけ seed を流す。 既に人が /projects で 1/0 を決めた後に
    // 再度流れると、 「切ったはずのプロジェクトが勝手に ON に戻る」ことになる。
    const columns = db.prepare("PRAGMA table_info(project_codes)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "domain_review")) return;
    db.exec("ALTER TABLE project_codes ADD COLUMN domain_review INTEGER NOT NULL DEFAULT 0");
    const rows = db.prepare("SELECT code, project, repo_origin FROM project_codes")
      .all() as Array<{ code: string; project: string; repo_origin: string | null }>;
    const enable = db.prepare("UPDATE project_codes SET domain_review = 1 WHERE code = ? COLLATE BINARY");
    for (const row of rows) {
      if (seedDomainReviewMigration91(row.project, row.repo_origin)) enable.run(row.code);
    }
  },
}, {
  version: 92,
  name: "domain-review-posts",
  source: "domain_review_posts / domain_review_answers — 投稿とその返信を追える形で残す (spec/feature/domain-review-discord.md §4)",
  up(db) {
    // 返信を回答として取り込むには「どの投稿への返信か」を知る必要がある。
    // Discord の message id は再起動をまたいで残るので in-memory では持てない。
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_review_posts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        code                TEXT NOT NULL,
        repo_path           TEXT NOT NULL,
        anatomia_project_id TEXT NOT NULL,
        plan_task_hash      TEXT,
        trigger_kind        TEXT NOT NULL,
        platform            TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        message_id          TEXT NOT NULL,
        questions           TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        UNIQUE(platform, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_domain_review_posts_created
        ON domain_review_posts(created_at DESC);
      CREATE TABLE IF NOT EXISTS domain_review_answers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id       INTEGER NOT NULL,
        kind          TEXT NOT NULL,
        answered_by   TEXT NOT NULL,
        answer_text   TEXT NOT NULL,
        source        TEXT NOT NULL,
        plan_appended INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_domain_review_answers_post
        ON domain_review_answers(post_id, created_at);
    `);
  },
}, {
  version: 93,
  name: "delegation-bundled-docs",
  source: "delegation_runs.bundled_docs — 委託 prompt へ本文同梱した別リポ md の一覧 (spec/feature/task-workflow.md §3.2)",
  up(db) {
    // 何を子へ渡したのかが run から分からないと、 前提の欠落を後から追えない。
    // 記録するのは `<project>:<repo-relative-path>` の JSON 配列で、 絶対パスは残さない。
    const columns = db.prepare("PRAGMA table_info(delegation_runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "bundled_docs")) {
      db.exec("ALTER TABLE delegation_runs ADD COLUMN bundled_docs TEXT");
    }
  },
}, {
  version: 94,
  name: "github-actor-roster",
  source: "github_actors — Issue にラベルを付けた / 起票した GitHub login の観測名簿 (spec/feature/github-issue-workflow.md — 信頼実行者)",
  up(db) {
    // 承認待ちで止まった相手を後から信頼実行者へ足すのに、 login の手入力を要求しない。
    // 権限の正本は設定 github.trusted_actors のまま — ここは観測記録だけを持つ
    // (Discord の社員名簿 staff_members と同じ形: 自動記録して役職は人が付ける)。
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_actors (
        login             TEXT PRIMARY KEY COLLATE NOCASE,
        display_login     TEXT NOT NULL,
        last_kind         TEXT NOT NULL,
        last_repo         TEXT NOT NULL,
        last_issue_number INTEGER NOT NULL,
        seen_count        INTEGER NOT NULL DEFAULT 1,
        first_seen_at     INTEGER NOT NULL,
        last_seen_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_github_actors_last_seen ON github_actors(last_seen_at);
    `);
  },
},
];

/**
 * 旧 allowlist (admin.reaction_workflow_{discord,slack}_users) の ID を「管理職」として
 * 名簿へ移す。 これが無いと移行直後に spawn 権限を持つ人間が 0 人になる。
 *
 * AdminState に永続値が無い環境 (GUI を一度も触らず、 廃止 env
 * `CONCORDIA_REACTION_WORKFLOW_{DISCORD,SLACK}_USERS` だけで運用していた場合) は、 その env を
 * 最後のフォールバックとして同じ扱いで取り込む。 env は移行後は読まれないので、 ここで拾わないと
 * アップグレードした瞬間に spawn / 発火できる人間が居なくなる。
 *
 * `*` (全員許可トークン) は役職に翻訳できないので捨てる — 移行後は名簿が唯一の判定源で、
 * 「全員許可」に相当する状態を残すと権限モデルが最初から無意味になるため。
 */
function migrateReactionAllowlistToStaff(db: Database.Database): void {
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO staff_members(
      platform, platform_user_id, display_name, profile_name,
      role, note, first_seen_at, last_seen_at, updated_at
    )
    VALUES (?, ?, '', '', 'manager', ?, ?, ?, ?)
    ON CONFLICT(platform, platform_user_id) DO NOTHING
  `);
  const note = "旧リアクションWF allowlist から移行 (管理職)";
  for (const [platform, key, envKey] of [
    ["discord", "admin.reaction_workflow_discord_users", "CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS"],
    ["slack", "admin.reaction_workflow_slack_users", "CONCORDIA_REACTION_WORKFLOW_SLACK_USERS"],
  ] as const) {
    const raw = (db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined)?.value;
    let ids: string[];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        ids = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        continue;
      }
    } else {
      // 旧 env の区切りは カンマ / 空白 / `;` (廃止した parseReactionUserAllowlist と同じ)。
      ids = (process.env[envKey] ?? "").split(/[\s,;]+/);
    }
    for (const id of ids) {
      const userId = id.trim();
      if (!userId || userId === "*") continue;
      insert.run(platform, userId, note, now, now, now);
    }
  }
}
