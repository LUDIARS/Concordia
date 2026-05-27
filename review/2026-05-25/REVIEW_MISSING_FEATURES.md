# 不足機能評価 (Concordia)

| リポジトリ | Concordia |
| --- | --- |
| 対象 HEAD | 142538d |

## 1. 機能の改善提案

| 対象機能 | 改善提案 | 期待効果 | 優先度 |
| --- | --- | --- | --- |
| rule-engine / stat-scheduler | per-repo queue で並列化、mutex contention 計測 | 高負荷時 p99 < 1s | Medium |
| admin state notification | chat_muted / rules_enabled 変更時 Webhook / EventBus | operator が即時認知 | Low |
| provider stub (gemini-cli / codex-cli) | parseTranscript 実装 + vitest | recovery 汎用性 (v0.2) | Medium |
| repo conflict detection | (repo_origin, host, branch) 全一致時のみ conflict (PR #34 後の追加調整) | false positive 削減 | Low |
| Tailscale multi-host 対応 | mTLS + hostname routing + remote sweeper | distributed Concordia (v0.3) | Low |

## 2. 不足機能の提案

| 提案機能 | 必要性 | 優先度 | 影響範囲 |
| --- | --- | --- | --- |
| admin_audit_log table | admin state 変更履歴がない | High | `src/db/schema.ts` + admin state setter |
| SLI/SLO 定義 + Prometheus exporter | 安定性の定量化 baseline がない | High | 新 `/v1/metrics` endpoint + prom-client |
| session-scoped temp token model | spawn token がグローバル永続 | Medium | `src/control/token.ts` + metadata |
| notification / alert system | sweeper error / rule failure 通知なし | Medium | webhook / ntfy / gotify channel |
| metadata rollback API | lictor_port 消失時の手動復旧手段 | Low | `PATCH /v1/sessions/:id/metadata-reset` |

## 総合評価

| # | 観点 | 指摘数 | 優先度別 |
| --- | --- | --- | --- |
| 1 | 機能改善 | 5 | High:1 / Medium:2 / Low:2 |
| 2 | 不足機能 | 5 | High:2 / Medium:2 / Low:1 |
