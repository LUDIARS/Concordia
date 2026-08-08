---
task: session-message-layer-d4-webui-chat
project: Concordia
kind: 実装
status: pending
created: 2026-08-07
source_session: lictor-7a639cae-6283-4d6d-a324-6cba7ab0f592
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# D4 — WebUI 作業チャット画面 + Web Push

## 目的

`/sessions/:id` を Discord 型の作業チャット画面にし、`session_messages` (D1, PR #293) を
`GET /v1/sessions/:id/messages` + WS `session.message` で描画する (`transcript.frame` からの
再構成をやめる)。あわせて Web Push 通知を実装する。

設計正本: `spec/feature/session-message-webui-chat.md` §1.1–§1.2・§1.4 と
`spec/tasks/2026-08-07-session-message-layer.md` の `D4` 節を参照すること。

## 完了条件

- PC: 左カラム(セッションリスト) + 右カラム(メッセージ+下部固定入力)。モバイル: ドロワー。
- `author_type` ごとの描画 (thinking 折りたたみ、task カード、delegation リンクチップ、
  question/permission ボタン)。状態カードは右上ボタン→オーバーレイ (既定非表示)。
- 本文コマンド `/stop` `/rename <text>` `/enter` `/stat` (未知の `/xxx` は inject せずエラー表示)。
- Web Push: `web/public/sw.js`、購読 UI、VAPID 鍵生成・保存、`web_push_subscriptions`、
  `web-push` 送信、410/404 で購読削除、`tag=session:<id>` 集約。
- 未読: `client_id` ごとの `last_read_id` サーバ保存 (D1 の `session_message_reads` を使用) +
  左カラムにバッジ。
- SRP: `pages/session-chat/` 配下に `SessionList` / `MessageList` / `MessageItem` /
  `ChatInput` / `StatusOverlay` / `commands.ts` / `push.ts` を分ける。

## スコープ (編集可ディレクトリ)

- `web/src/pages/session-chat/` (新設), `web/public/sw.js` (新設)
- `src/api/` (push routes), `src/db/` (`web_push_subscriptions` 追加マイグレーション)
- D1 (`session_messages` 基盤) の PR #293 がマージされてから着手する。
