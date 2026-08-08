---
task: session-message-layer-d5-webui-logs
project: Concordia
kind: 実装
status: pending
created: 2026-08-07
source_session: lictor-7a639cae-6283-4d6d-a324-6cba7ab0f592
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# D5 — WebUI ログ確認画面へ再編

## 目的

現行 `SessionDetail` の raw 系 (transcript 全フレーム / event log / 最新 stat / fork /
permission 履歴) を `/sessions/:id/logs` に集約し、`/sessions` (一覧のみ) を新設する。
D4 (作業チャット画面) が `/sessions/:id` を占有した後の再編。

設計正本: `spec/feature/session-message-webui-chat.md` §1.1・§1.3 と
`spec/tasks/2026-08-07-session-message-layer.md` の `D5` 節を参照すること (D4 と併走可)。

## 完了条件

- `/sessions/:id/logs` に raw 系 (transcript 全フレーム / event log / 最新 stat / fork /
  permission 履歴) が揃う。
- `/sessions` (一覧のみ) が追加される。
- チャットとログの相互リンク、Monitor からのリンク先が正しく解決する。
- 移設で不要になった旧 `ConversationPanel` 等は削除する (リネーム/コメントアウトで残さない)。

## スコープ (編集可ディレクトリ)

- `web/src/pages/session-detail/` (再編), `web/src/pages/session-logs/` (新設想定)
- D1 (`session_messages` 基盤) の PR #293 がマージされてから着手する。D4 と併走可。
