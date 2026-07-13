---
type: feature
title: "ゴールアンドゴー (goal-and-go 自走継続)"
description: "最終回答後に人間入力がないopt-inセッションへ、ゴール達成または残作業解消のための上限付き続行injectを送る。"
service: concordia
domain: session-coordination
tags:
  - lifecycle
  - state-machine
  - injection
  - autonomous
  - safety
status: implemented
updated: 2026-07-13
related:
  - feature/task-workflow.md
---

# ゴールアンドゴー (goal-and-go 自走継続)

`idle-nudge`の最終回答後待機判定を土台に、待機を人間への催促だけでなく、明示的に
opt-inしたAIセッション自身の自走継続につなげる。

## 発動条件

- `final_answer`または`summary`から既定300秒、人間の入力がない。
- `sessions.metadata.goal_and_go.enabled`が`true`。既定はOFF。
- セッションが`active`で、安全上限による停止状態ではない。

人間の`user_activity`、ユーザ発話、人間由来injectは待機タイマを解除し、自走の回数・時間
予算をリセットする。セッション終了・喪失でもタイマを解除する。

## フラグの操作と保存

- 既存セッション: `GET/POST /v1/sessions/:id/goal-and-go`。POST bodyは
  `{ "enabled": boolean }`。
- 新規delegation/spawn: runtime option `goal_and_go: true`。Ccのpending spawn registryを
  介して、登録されたセッションmetadataへopt-inを焼く。Lictor向けenv
  `CONCORDIA_DELEGATION_GOAL_AND_GO=1`も併用する。
- Cc再起動後もフラグと安全予算を保持できるよう、状態はセッションmetadataへ永続化する。

## ゴールと残作業の判断

- metadataに明示`goal`がある場合、既存の`/co-goal` / goal APIを正本とする。Ccはゴール、
  現在タスク、達成度評価と次タスク実行の指示を同じセッションへinjectする。
- 明示goalがない場合、現在の指示、`current_task`、git diff、未完了TODO、利用可能な
  タスク管理情報から残作業を調べるようinjectする。
- 達成度や残作業の意味判断は、文脈を保持している同じAIセッション自身が行う。CcはLLMを
  内包せず、待機・opt-in・安全上限を決定論的に管理する。
- 続行は既存の`session.inject`経路を使う。新しいセッションは作らない。

## 暴走防止

- 人間入力1サイクル当たり既定6回まで
  (`CONCORDIA_GOAL_AND_GO_MAX_CONTINUATIONS`)。
- 最初の自走injectから既定2時間まで
  (`CONCORDIA_GOAL_AND_GO_MAX_RUNTIME_SEC`)。
- 待機秒数は`CONCORDIA_GOAL_AND_GO_IDLE_SEC`、既定300。0以下で全体無効。
- 上限到達時はinjectせず`goal_and_go_stopped`イベントと停止理由を保存する。次の人間入力で
  予算をリセットする。
- 人間判断、新しい権限、スコープ拡張が必要なら質問して停止するよう続行promptへ明記する。

## 受け入れ基準

- [x] フラグOFFのセッションは自走しない。
- [x] フラグONかつ300秒無入力で同じセッションへ続行injectを1回送る。
- [x] 明示goalの有無で、達成度評価と残作業探索を切り替える。
- [x] 人間入力はタイマを解除し、安全予算をリセットする。
- [x] 回数・時間上限を超えてinjectしない。
- [x] APIとdelegation runtime optionからopt-inできる。
