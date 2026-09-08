---
task: session-chat-mobile-touch
project: Concordia
kind: 実装
created: 2026-09-08
memory_links:
  - spec/feature/session-message-webui-chat.md
---

# チャットのダブルタップズームを抑止する

## 目的
スマートフォンからCcチャットを操作するときの意図しない拡大を減らす。

## 受け入れ条件
- チャット画面でダブルタップズームを抑止し、スクロールとピンチズームを許容する。
- Discordアプリの表示処理は変更しない。

## 作業範囲
session-message-webuiのタッチ操作設定。実機評価の実施有無を報告する。
進行状態はtaskflow_task_stateが正本。
