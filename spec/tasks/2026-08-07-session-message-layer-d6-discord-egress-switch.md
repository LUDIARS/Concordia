---
task: session-message-layer-d6-discord-egress-switch
project: Concordia
kind: 実装
status: pending
created: 2026-08-07
source_session: lictor-7a639cae-6283-4d6d-a324-6cba7ab0f592
memoria_task_id: null
actio_task_id: null
memory_links: []
---
# D6 — Discord egress を session_messages 経由へ切替

## 目的

`src/discord/egress.ts` の `transcript.frame` ハンドラを `session.message` (D1, PR #293) 購読へ
置き換え、Discord と WebUI (D4) が同じレコードを描画するようにする。D1+D2 (Lictor の frame
取りこぼし修正) の両方が完了してから着手する最終段。

設計正本: D1 とともに `spec/feature/session-message-layer.md` および
`spec/tasks/2026-08-07-session-message-layer.md` が本リポジトリにマージされた後、それぞれの
§7.3・§9 と `D6` 節を参照すること。両ファイルが未マージの間は着手しない (D1+D2 依存)。
D2 (Lictor 側の `lineToFrames` 化・Task/thinking 拡張) は Lictor リポジトリ側の別タスク。

## 完了条件

- `session.message` 購読に置き換わり、送信結果の Discord message id を
  `session_message_delivery` に記録、`op=update` は Discord message **edit** で反映される
  (Task の完了など)。
- `author_type=thinking` は既定で引用ブロックとして投稿し、`message_optimization` ON では
  落ちる (`egress-frame-filter.ts` に判断を実装しない)。
- 既存 dedupe (`shouldSkipCodexDuplicate`) を `dedupe_key` に一本化できるか確認し、できれば置換。
- 切替後、実セッションで Discord と WebUI の表示が一致することを確認する。

## スコープ (編集可ディレクトリ)

- `src/discord/egress.ts`, `src/discord/egress-frame-filter.ts`, `src/messages/`
- D1 (`session_messages` 基盤) の PR #293、および Lictor 側 D2 の両方がマージされてから着手する。
