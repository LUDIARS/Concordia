---
type: data
title: "データスキーマ"
description: "Concordia の SQLite (better-sqlite3, WAL) スキーマ一覧。SCHEMA_VERSION=71、セッション中核・message layer・chat/tasks・ルールエンジン・Discord/Slack連携・delegation・teams・project code registry・observability の主要テーブルを記載する。権威は src/db/schema.ts。"
service: concordia
domain: persistence
tags:
  - sqlite
  - schema
  - session-coordination
  - discord
  - persona
  - delegation
  - observability
  - lifecycle
status: implemented
related:
  - ../interface/service-schema.md
  - ../feature/delegation-implementation-inject.md
updated: 2026-08-22
---


# データスキーマ

Concordia の SQLite（better-sqlite3, WAL）スキーマ一覧。正本は
[`../../src/db/schema.ts`](../../src/db/schema.ts)（`SCHEMA_VERSION = 71`、
`STATEMENTS` 配列）。dialect 変換ルール: UUID→text PK / JSONB→text(JSON) /
BOOLEAN→integer 0,1 / TIMESTAMPTZ→integer(epoch ms) / TEXT[]→text(JSON array)。
API/機能視点は [`../interface/service-schema.md`](../interface/service-schema.md)。

> 完全な列定義・型・既定は schema.ts が権威。本書は **テーブル一覧（用途 + 主要列 +
> 主インデックス）**。

## メタ
| テーブル | 用途 | 主キー / 主要列 |
|---|---|---|
| `schema_meta` | スキーマ版など key/value | key PK, value |

## セッション中核
| テーブル | 用途 | 主要列 |
|---|---|---|
| `sessions` | 登録された AI セッション | id PK / provider / repo_path / repo_origin / branch / host / started_at / ended_at / status / last_seen_at / current_task / transcript_path / ws_clients。INDEX: repo_path×status / repo_origin×status / status×last_seen / host×status |
| `session_events` | start/prompt/edit/end 等の離散イベント | id / session_id / ts / kind / payload。INDEX: session×ts / kind×ts |
| `session_reports` | セッション終了レポート | session_id PK / generated_at / summary_md / bullets / duration_sec |
| `session_task_records` | TodoWrite 永続化（残作業判定） | session_id / task_text / status / first_seen / last_updated / completed_at / handled_by_session。UNIQUE(session_id, task_text) |
| `session_stats` | 10 分 poll の現況 JSON（他 session も参照可、既定90日保持） | session_id / ts / payload(JSON) |
| `transcript_logs` | Lictor transcript-tail の frame（既定90日保持） | session_id / seq / ts / kind / payload。UNIQUE(session_id, seq)（冪等） |
| `session_messages` | 表示用の正規セッション作業ストリーム（`transcript_logs` と同じ保持期間） | id / session_id / ts / edited_ts / author_* / content / embeds / components / attachments / reference_id / metadata / dedupe_key。UNIQUE(session_id, dedupe_key) |
| `session_message_reads` | browser client ごとの単調増加する既読位置 | client_id / session_id / last_read_id / updated_at。PK(client_id, session_id) |
| `session_message_delivery` | 将来の配送先別外部 message ID（現フェーズは書き手なし） | message_id / platform / external_id / ts。PK(message_id, platform) |

## chat / tasks
| テーブル | 用途 | 主要列 |
|---|---|---|
| `chat_messages` | チャット（channel/session 単位） | id / channel / session_id / author_label / ts / text / in_reply_to / is_actionable / metadata |
| `pending_tasks` | session へ配送待ちのタスク | id / session_id / kind / payload / created_at / delivered_at / expires_at / retries |
| `taskflow_task_state` | task Markdown に対応する mutable runtime state | repo_path / task_path (複合 PK) / status (4 値制約) / source_session / assignee / owner / delegation_run_id / pr_number / memoria_task_id / actio_task_id / memoria_registration_state (3 値制約、created と memoria_task_id を整合)。Markdown は static definition のみ。 |

## skill
| テーブル | 用途 | 主要列 |
|---|---|---|
| `skill_snapshots` | SKILL.md スナップショット + poison/growth 解析 | repo_path / skill_name / ts / content_hash / content / size_bytes / poison_score / growth_score |

## ルールエンジン
| テーブル | 用途 | 主要列 |
|---|---|---|
| `rules` | tick/event トリガのルール | id PK / trigger_type / tick_sec / event_kind / conditions(JSON) / instructions / target / cooldown_sec / enabled |
| `rules_log` | ルールの add/remove/fire/skip/error 履歴（既定90日保持） | id / ts / rule_id / action / actor |

## レポート / ペルソナ
| テーブル | 用途 | 主要列 |
|---|---|---|
| `day_reports` | AI 日報（日次集約） | date_iso PK / generated_at / summary_md / bullets / session_count / total_duration_sec |
| `personas` | セッションに割り当てる人格 | id PK / name / traits / speech_style / skill_template / learned_notes / display_name |
| `persona_assignments` | persona ↔ session 割当（排他） | persona_id / session_id / assigned_at / released_at。partial UNIQUE で同時 active を 1:1 に |
| `persona_feedback_log` | persona への feedback 反映ログ | persona_id / session_id / ts / kind / delta |

## managed processes（v0.2）
| テーブル | 用途 | 主要列 |
|---|---|---|
| `processes` | Concordia が spawn/監視するプロセス | name PK / cwd / command / repo_path / pid / status / log_path / metadata |
| `process_logs` | プロセス出力ログ（pull 用） | process_name / ts / stream / level / line |

## observability の移管

ホスト・サービス監視、liveness、エラー検知、自動修正、監査ログの権威ソースは
Excubitor である。旧 Concordia テーブルは schema v35 の one-shot migration で削除する。
既存DBではサービスと worker を停止して `.bak` を作成後、
`CONCORDIA_DB_APPLY_EXCUBITOR_DROP=1` を付けた起動で DROP + VACUUM を実行する。

## Discord 連携
| テーブル | 用途 | 主要列 |
|---|---|---|
| `discord_config` | bot 設定 key/value（guild/category/meta channel） | key PK / value |
| `discord_session_channels` | session ↔ Discord channel/thread + 状態 | session_id PK / channel_id / channel_kind(channel/thread) / webhook_id / webhook_token / status(active/lost/ended) / last_rename_ts |
| `discord_message_map` | Discord message id ↔ chat_messages.id | discord_message_id PK / chat_message_id / ts |
| `chat_message_reactions` | reaction(fine/bad/raw) | message_id / discord_user_id / kind。UNIQUE(message_id, user, kind) |
| `discord_pending_questions` | Discord 経由の AskUserQuestion 待ち | session_id / question / options_json / discord_message_id / answer_index |

## delegation（v0.3）
| テーブル | 用途 | 主要列 |
|---|---|---|
| `delegation_templates` | 委託テンプレ | id PK / call_name UNIQUE / target_provider / prompt_template / input_schema / default_cwd |
| `delegation_runs` | 委託実行履歴とqueue状態機械 | id PK / template_id / call_name / target_provider / team_id / args_json / rendered_prompt / prompt_file_path / spawn_pid / status / queue_owner / queue_lease_until / queue_fencing_token / effort_level / effort_source / effort_bucket / effective_model / effort_decision_id / staged_injection / staged_followup_at / investigation_summary / memoria_task_id / memoria_task_url / finished_at |
| `delegation_outbox` | claimと同時に永続化するlaunch intent | run_id / kind / payload_json / status / owner / fencing_token / delivered_at。UNIQUE(run_id, kind) |

## Teams
| テーブル | 用途 | 主要列 |
|---|---|---|
| `teams` | チーム設定と Discord category の正本 | id PK / name / slug UNIQUE / settings_json / rules_text / discord_category_id / created_at / updated_at |
| `team_repos` | チームと repository origin の関連 | team_id / repo_origin。PK(team_id, repo_origin) |
| `team_surfaces` | チーム面ごとの Discord channel | team_id / surface / channel_id。PK(team_id, surface) |

## Project code registry
| テーブル | 用途 | 主要列 |
|---|---|---|
| `project_codes` | Cc が所有する project code と Git repository の対応。初期 seed なし | code PK（case-sensitive）/ project UNIQUE / repo_path UNIQUE / repo_origin UNIQUE / added_by / created_at / updated_at |

> マイグレーションは番号・名前・SHA-256 checksumを `schema_migrations` に記録する。
> `src/db/migrator.ts` の単一 migrator が `BEGIN IMMEDIATE` でwriterを直列化し、DDL、冪等ALTER、
> backfill、ledger、`schema_meta.version` を一つのtransactionでcommitする。適用済みmigrationの
> source変更はchecksum mismatchとして起動を拒否する。
