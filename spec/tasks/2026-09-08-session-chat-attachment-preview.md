---
task: session-chat-attachment-preview
project: Concordia
kind: 実装
created: 2026-09-08
memory_links:
  - spec/feature/session-message-webui-chat.md
  - spec/ux/product.md
---

# セッションチャットで資料を閲覧する

## 目的
UX-CC-W3。Ccのチャットから添付テキストと画像を確認できるようにする。

## 受け入れ条件
- 既存の資料投稿とcanonical画像を表示し、テキストを展開して読める。
- 保存済みsessionと投稿の同一性を照合し、許可ルート・サイズ上限・秘密ファイル拒否を維持する。
- 取得失敗を表示して再試行でき、移動時に取得を中止する。本文と既読位置を壊さない。

## 作業範囲
ConcordiaのHTTP adapter、ChatRepo、session-message-webui。仕様§5に沿う。
進行状態はtaskflow_task_stateが正本。テストと起動は明示許可範囲のみ。
