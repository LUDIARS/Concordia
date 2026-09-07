---
task: stop-human-wait-confirmation-loop
project: Concordia
kind: 実装
created: 2026-09-07
memory_links: []
---

# 人間が反応しない確認ループを停止する

## 目的

人間待ちのまま残作業確認や自動確認が繰り返される無駄を止める。AI自身の返答を人間の反応と
みなさず、確認を一度送った後は人間の入力まで待つ。

## 完了条件

- 確認済み待機を永続化し、無応答・AI返答・自動注入・再起動では再確認しない。
- 人間の入力・カード回答によって通常の判定を再び許可する。
- 未回答質問を迂回する phase handoff を止め、無反応を終了許可にしない。
- 既知の未完了タスクを進める自走経路と、仕事の有無を繰り返し尋ねる経路を区別する。
- テスト・起動・再起動は実行せず、commit と local PR 提出まで行う。

## スコープ (編集可ディレクトリ)

`src/control/`、`src/taskflow/`、`src/bootstrap/`、`spec/domains/`、`spec/feature/`、
`spec/plan/problem_logs/`。状態は Cc DB が所有し、この task md に進行を書き戻さない。
