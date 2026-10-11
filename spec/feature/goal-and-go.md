---
type: feature
title: "ゴールアンドゴー (goal-and-go 自走継続)"
description: "全セッションで既定有効とし、明示OFF以外へゴール達成または残作業解消のための上限付き続行injectを送る。"
service: concordia
domain: session-coordination
tags:
  - lifecycle
  - state-machine
  - injection
  - autonomous
  - safety
status: implemented
updated: 2026-08-25
related:
  - feature/task-workflow.md
---

# ゴールアンドゴー (goal-and-go 自走継続)

`idle-nudge`の最終回答後待機判定を土台に、待機を人間への催促だけでなく、AIセッション
自身の自走継続につなげる。2026-08-25 neco 指示により全セッション既定 ON とし、明示的な
OFF だけを例外として保持する。

## 発動条件

- `final_answer`または`summary`から既定300秒、人間の入力がない。
- `sessions.metadata.goal_and_go.enabled`が明示的な`false`ではない。既定はON。
- セッションが`active`で、安全上限による停止状態ではない。

人間の`user_activity`、ユーザ発話、人間由来injectは待機タイマを解除し、自走の回数・時間
予算をリセットする。セッション終了・喪失でもタイマを解除する。

## フラグの操作と保存

- 既存セッション: `GET/POST /v1/sessions/:id/goal-and-go`。POST bodyは
  `{ "enabled": boolean }`。
- Discord のセッションチャンネルでは `/co-go-and-go state:<on|off>` で切り替え、引数なしで
  現在値と継続回数を確認できる。
- 新規delegation/spawn: runtime option の省略または `goal_and_go: true` でON、
  `goal_and_go: false` のときだけOFF。Ccのpending spawn registryを介して、登録された
  セッションmetadataへ明示値を焼く。ON時はLictor向けenv
  `CONCORDIA_DELEGATION_GOAL_AND_GO=1`も併用し、明示OFF時は継承環境を確実に
  上書きするため `CONCORDIA_DELEGATION_GOAL_AND_GO=0` を渡す。
- Cc再起動後もフラグと安全予算を保持できるよう、状態はセッションmetadataへ永続化する。

## ゴールと残作業の判断

### CC-GO-REMAINING-01: 報告した残件からの自動継続

2026-10-11 neco 指示: Goal & Go は自動で ON とし、「残っていること」で進められるものを
自動で進める Inject にする。既存の default ON は維持し、明示 OFF を上書きしない。

- 価値: UX-CC-W2/W4、UX-CC-S3/S5。依頼者が毎回 GO を言い直さなくても許可済みの残件が進み、
  判断待ちを勝手に通過しない状態を守る。
- 状態所有者: 継続フラグ・予算・指示受領は autonomous-continuation、task 状態は Actio、
  起動時方針・状態別 followup は session-coordination。残件報告は候補であり、権限や task 状態の正本ではない。
- 起動時の作業方針、通常 workflow、Goal & Go、状態別 followup は同じ純粋な文面定義を使い、
  直近の「残っていること」を人間の依頼・既存許可・対応する Actio task と照合するよう指示する。
- 進められる項目は再度 GO や同じ開始確認を求めず、そのターンで実行する。未確認の項目は
  読み取りで事実を確認し、unknown を成功・完了・新たな許可と扱わない。
- 審査・委託の結果待ちは通知を待つ。同じ依頼内で独立して進められる作業があれば続ける。
  結果不明の操作の再送、審査のポーリング、重複提出、指示外の作業追加はしない。
- 全てが待機なら理由を示す。人間判断が必要な場合だけ human-wait に記録し、通常の審査通知待ちを
  人間判断待ちへ変換しない。明示 OFF、未回答質問、部署の自動確認 OFF、継続予算の機械的判定を維持する。
- この文面変更は新しい timer・定期実行・RWF を作らない。従来の idle timer は撤去済みであり、
  上記の300秒発動条件は歴史的仕様。現行の開始契機は inquiry / taskflow.continue_requested と状態別 followup。
- 管理画面に保存された Inject 上書きは既定文面より優先する。変更時は対象の現 revision を照合し、
  当該段落だけを更新する。コードのマージだけで保存済み上書きへ反映済みとはしない。

受入検証: 4 経路の生成文面が残件継続と停止条件を含むこと、default ON のセッションが人間入力後に
同じ session へ継続し、明示 OFF / 未回答質問 / 人間待ちでは継続しないことを回帰対象とする。
実機評価・人間承認・テスト実行済みをこの仕様だけで主張しない。

- metadataに明示`goal`がある場合、既存の`/co-goal` / goal APIを正本とする。Ccはゴール、
  現在タスク、達成度評価と次タスク実行の指示を同じセッションへinjectする。
- 明示goalがない場合、人間から受けた指示の作業に残りがあるときだけ続け、終わっていれば
  待機するようinjectする。

## 指示されていないセッション外のタスクを持ち込まない (2026-10-07 neco 指示)

起動直後や作業の区切りで、指示に無い作業をセッションが始めていた。原因は自走継続の文面
(git diff・TODO・タスク管理情報から次のタスクを定義して実行させていた) と、残作業 sweep
(`taskflow:residual`) が見つけたプロジェクトの未着手タスクを `current_task` に書き込んで
自走させていたこと。

- 人間の指示を一度も受けていないセッションには自走継続を送らない。状態所有者は
  `sessions.metadata.goal_and_go.instructed` (goal-and-go が所有)。人間の`user_activity`、
  ユーザ発話、人間由来injectで `true` になり、明示`goal`の登録も指示として扱う。
- `taskflow.continue_requested` の本文 (sweep が見つけた次タスク) は `current_task` に持ち込まない。
  自走継続はセッション自身の `current_task` だけを続ける。
- 自走継続の文面は「受けた指示の範囲だけで作業し、Actio の未着手 task・git diff・TODO などの
  セッション外のタスクを持ち込まない」と明示する。
- 不変条件: 自走継続 inject は、`instructed=true` または明示`goal`を持つセッションにだけ届く。
- 達成度や残作業の意味判断は、文脈を保持している同じAIセッション自身が行う。CcはLLMを
  内包せず、待機・opt-in・安全上限を決定論的に管理する。
- 続行は既存の`session.inject`経路を使う。新しいセッションは作らない。

## 未回答の質問は blocker (2026-08-11)

セッションが ask カードを出して人間の判断を待っている間は、**自走継続を送らない**。

- 判定の正本は `discord_pending_questions` の未回答行
  (`findLatestUnanswered`)。ask マーカー / picker / WebUI のどの経路で出した質問でも同じ。
- 送らなかった場合、`continuation_count` も消費しない。回答が付けば本来の回数だけ自走できる。
- 同じ blocker を taskflow の自動 inject (分解プロンプト / teardown ladder 予約) と
  `POST /v1/inquiry` のタスク自動 inject にも適用する
  (`src/control/pending-question-blocker.ts`)。
- **止めないもの**: 人間の発言 (Discord/Slack チャット)、回答そのもの
  (`answer-question`)、終了指示 (`auto:session-end`)。
- 取りこぼしは Lictor 側の pending-question gate が pty 直前で保留する
  (`Lictor/spec/feature/askquestion-pending-gate.md`)。Cc 側は「そもそも送らない」層。

**なぜ必要か**: 自動 inject は pty には user メッセージとして届く。質問が開いたまま
これを流すと、モデルは自分の質問に自分で答えて先へ進んでしまい、人間から見ると
「答えていないのに勝手に決まった」状態になる。

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

- [x] metadata未設定の既存・新規セッションはONとして扱い、明示OFFだけは自走しない。
- [x] フラグONかつ300秒無入力で同じセッションへ続行injectを1回送る。
- [x] 明示goalの有無で、達成度評価と残作業探索を切り替える。
- [x] 人間入力はタイマを解除し、安全予算をリセットする。
- [x] 回数・時間上限を超えてinjectしない。
- [x] APIとdelegation runtime optionから明示OFF/再ONできる。
- [x] 未回答の質問があるセッションへは自走継続injectを送らず、継続回数も消費しない。
