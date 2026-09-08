---
task: session-chat-rwf-emoji-input
project: Concordia
kind: 実装
created: 2026-09-08
memory_links:
  - spec/feature/session-message-webui-chat.md
---

# RWF登録済み絵文字をチャットへ入力する

## 目的
登録済みの絵文字をCcチャットから選べるようにする。

## 受け入れ条件
- RWF既定値・上書き・解除・カスタムスキル割当を登録APIから取得し、重複を整理する。
- 選択でカーソル位置へ挿入し、通常の送信操作を維持する。選択のみでは自動送信しない。
- 一覧取得の失敗が分かり、停止sessionと送信中は選択できない。

## 作業範囲
session-message-webui入力コンポーネント。RWF設定を書き換えない。
進行状態はtaskflow_task_stateが正本。テスト実行は明示許可範囲のみ。
