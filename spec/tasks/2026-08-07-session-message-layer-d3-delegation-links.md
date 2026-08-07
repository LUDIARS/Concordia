---
task: session-message-layer-d3-delegation-links
project: Concordia
kind: 実装
status: pending
created: 2026-08-07
source_session: lictor-7a639cae-6283-4d6d-a324-6cba7ab0f592
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# D3 — Delegation 親子双方向リンク

## 目的

`delegation.mirror` が現状「親セッションにしか出ない」ため、子セッションのチャットに
「親: `<session>` / run: `<run_id>`」のリンクが無い。D1 (`session_messages` 基盤、PR #293)
の上に、親子双方向のリンクメッセージ投稿と `/v1/sessions/:id/links` API を実装する。

設計正本: D1 とともに `spec/feature/session-message-layer.md` および
`spec/tasks/2026-08-07-session-message-layer.md` が本リポジトリにマージされた後、それぞれの §8 と
`D3` 節を参照すること。両ファイルが未マージの間は着手しない。

## 完了条件

- run 生成時 (`child_session_id` 確定時) に、子セッションへも `author_type=delegation`,
  `dedupe_key=delegation:<run_id>:child` のリンクメッセージが 1 回だけ投稿される。
- 親側にも `dedupe_key=delegation:<run_id>:parent` で同様に投稿される。
- `metadata` に `run_id` / `parent_session_id` / `child_session_id` を持つ。
- `GET /v1/sessions/:id/links` がそのセッションの親・子一覧を返す。
- テスト: 親子双方に 1 通ずつ出ること、同じ run で二重投稿されないこと。

## スコープ (編集可ディレクトリ)

- `src/delegation/`, `src/messages/`, `src/api/`, `src/db/` (Concordia repo 内)
- D1 (`session_messages` 基盤) の PR #293 がマージされてから着手する。
