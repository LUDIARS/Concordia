# Web 実装評価 (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 142538d |

## 1. データスキーマ (A)

| テーブル | 所見 |
| --- | --- |
| sessions | (id PK / provider / repo_path / branch / host / status) インデックス (repo_path, status) / (repo_origin, status) / (status, last_seen_at) で query pattern カバー |
| session_events | kind+ts でローリング集計可、event kind 種別明確 |
| session_task_records (NEW PR #29) | UNIQUE(session_id, task_text) で upsert idiom、completed_at フリーズが履歴保護 |
| session_reports | metadata JSON で extensible、per-session 1 row denormalize |
| chat_messages | (channel, ts DESC) index で range query |
| pending_tasks | delivered_at / expires_at で GC 容易 |
| skill_snapshots | poison_score / growth_score を JSON array で flexible |
| rules | trigger_type (tick/event) + conditions (JSON array)、cooldown_sec でレート制御 |

- 正規化: 1NF-3NF 準拠、metadata JSON は意図的 (extensibility)
- 制約: PK / UNIQUE で重複防止、FK explicit なし (cascade 不要)
- マイグレーション: SCHEMA_VERSION=12、backward compat 維持
- N+1 回避: batch select / aggregate query

## 2. SRE (B、重大指摘 1)

| 観点 | 評価 | 所見 |
| --- | --- | --- |
| 可観測性 | B | pino logger 統一、child logger で context 付与。traceID/requestID propagation 未実装 |
| デプロイ安全性 | **B (重大指摘)** | npm run build → tsc + web build の 2-stage、graceful shutdown / zero-downtime 手順未文書化 |
| スケーラビリティ | B | sqlite WAL で multi-process safe、1000+ session 並行時の mutex 性能未測定 |
| 障害復旧 | B | transcript_path で lost recovery 可、backup schedule は運用任せ |
| 依存関係 | A | npm audit clean、Node 22 pinned |

### 重大指摘 1

**デプロイ runbook 不在**: `docs/deploy.md` を新設。Blue-Green / Canary / Rollback 手順、sqlite WAL の multi-process safety 検証ログ、stat-scheduler / rule-engine 停止再開順序を記載。

## 重大指摘合計

- データスキーマ: 0
- SRE: 1 (Medium)
