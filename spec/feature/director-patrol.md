---
type: feature
title: "Director 巡回 — 30 分ごとのチーム監視と実装セッションの自動起動"
description: "30 分ごとに各チームの director case を巡回し、完了した委託を工程へ反映し、実行可能な残 step があればチーム帰属の実装セッションを delegation で起動する。人間の判断が要る状態は direction 面の question カードへ上げる。タスクリストと目標のデイリー更新は朝礼 (team-standup-daily) に統合する。"
service: concordia
domain: governance
tags:
  - director
  - teams
  - delegation
  - scheduler
  - goal-and-go
status: superseded
related:
  - feature/director.md
  - feature/director-goal-flow.md
  - feature/teams.md
  - feature/team-standup-and-review.md
  - feature/curiosity-walk.md
updated: 2026-09-01
---

# Director 巡回 — 30 分ごとのチーム監視と実装セッションの自動起動

> **休止 (2026-09-01 neco 指示)**: 「チームの動作が形骸化しており巡回があまり有効でない。
> チームはチーム内で spawn するだけにする。巡回由来の装置は散歩セッション
> ([curiosity-walk.md](curiosity-walk.md)) だけを適用する」。
> 本 spec の巡回 runtime (実装セッション自動起動・問診) は bootstrap から外し、
> workflow binding key `director` は空いた。コード (`src/director/patrol*.ts`,
> `inquiry-*.ts`) は再開に備えて残す。あわせて teams fanout の定時ジョブ 4 本
> (朝礼 / 定例 / 課題スカウト / タスク整理) も cron から外した。

> 2026-08-20 neco 指示。「動作させているチームの様子を 30 分おきに確認し、目標に対して
> 残タスクで実行できるものがあれば、チームセッションを作成して実装できるようにする。
> これは『ディレクター判断』で行うものとする。ところどころ人間の判断が必要なものは
> 出てくるはずなので、それは人間に聞く。タスクリスト (いまは Memoria) と目標の更新を
> 毎日やる。これは朝礼と一緒にやる」。

## 0. 位置づけ

[director-goal-flow.md](director-goal-flow.md) が「イベント駆動の工程自動進行」を後続工程と
していた部分のうち、**巡回 (polling) 形の進行**を本 spec で確定する。原則は director.md §0 を
維持する:

- 巡回エンジンは **LLM を呼ばない**。決定的な状態機械であり、生成・判断は委託先セッションと
  Genius に委ねる。
- 権限・スコープ・破壊的操作・予算超過は人間に上げる (ask_human / question カード)。
- 巡回は taskflow / delegation / PR の正本を複製しない。director_steps の参照
  (delegation_run_id) を更新するだけで、run や PR の状態は既存テーブルが唯一の正本。

## 1. 巡回 (`director-patrol`)

`src/director/patrol.ts` (純関数の計画) + `src/director/patrol-runtime.ts` (30 分間隔の
supervised interval)。workflow binding key は `director` (workflow-toggles で単独に ON/OFF
できる。既定 ON)。

各 tick でチームごとに次を行う。1 チームの失敗は他チームへ波及させない。

### 1.1 反映 (reconcile)

`active` かつ `delegation_run_id` を持つ delegate / implement step について、参照先の
delegation run の現在 status を読み:

| run status | step への反映 |
|---|---|
| completed | `completed` へ進める |
| failed / spawn_failed | `blocked` へ。handoff_note に失敗理由。question カードで人間へ通知 |
| 上記以外 (実行中・待機中) | 触らない (チームの同時実行スロットを 1 つ占有) |

run 行が見つからない場合も `blocked` にする (参照破損は人間の確認対象)。

### 1.2 検出 (detect) と起動 (launch)

- 対象 case: そのチーム (`team_id`) の、未完了 step を持つ case。
- 実行可能 step = sequence 順で先行 step がすべて completed / cancelled であり、
  自身が `pending` の `delegate` / `implement` step。
- `plan` / `decompose` / `review` / `confirm` が次工程の case は巡回では起動しない
  (それらは plan-gate・定例・confirm フローの持ち場)。巡回は実装の進行だけを担う。
- 起動条件 (すべて AND):
  - case の起動済み run 数 (delegation_run_id を持つ step 数) < 予算 (既定 10)
  - チームの実行中 step 数 < チーム同時実行上限 (既定 1)
  - 1 tick あたりの新規起動数 (既定 1) 以内
- 競合時は case の created_at 昇順 (古い目標を先に進める)。決定的で、Genius は呼ばない。
  優先順位を変えたい場合は人間が定例 / PATCH steps で並べ替える。

起動は delegation `sonnet-mid` (env `CONCORDIA_DIRECTOR_IMPL_CALL_NAME` で上書き可)
を `options: { team: <team_id>, goal_and_go: true }` で invoke する。args:

- `task`: case title / goal / step title / task_path (あれば) を束ねた実装指示
- `target_repo`: チームの repos と case.project から解決したローカルクローン
  (`repoNameFromOrigin` → `resolveClonePaths`)。チームの repo が 1 本ならそれ、
  複数なら case.project と repo 名の一致で選ぶ。解決できなければ起動せず
  question カードへ上げる。

起動後、step へ `delegation_run_id` を記録して `active` にする。

起動されたセッションは**最初に人間の担当者へメンションする** (2026-08-20 neco 指示)。
担当者は `GET /v1/admin/state` の `mention_user_id` を正本とし、着手宣言の先頭に
`<@mention_user_id>` を付ける (未設定なら宣言のみ)。

### 1.3 冪等性・二重起動防止

- `triggered_by = "director-patrol:<step_id>"` を固定キーにし、起動前に
  `findRunByTriggeredBy` で既存 run を確認する。あれば invoke せず step へ run id を
  復元する (invoke 成功 → 記録前のクラッシュから回復する)。
- step が `active` + run id 保持 → 候補にならない。

### 1.4 人間へのエスカレーション

判断が要る状態は Discord チームの direction 面へ `question` カード
(`team.card_requested`, kind=`question`) として 1 枚出す:

- 委託 run の失敗 (§1.1)
- 委託の起動失敗
- case 予算 (run 回数) の超過 — 巡回は起動を止め、人間が予算を引き上げるか case を
  整理するまで再起動しない
- target_repo が解決できない

同一 case × 同一理由のカードはプロセス内で日単位に重複抑止する (再起動を跨ぐ完全な
重複防止はしない — 日次の朝礼が定常状態の正本レポートを担う)。実行可能 step がない
だけの case はエスカレーションしない (朝礼・定例が扱う)。

## 2. タスクリストと目標のデイリー更新 (朝礼へ統合)

[team-standup-and-review.md](team-standup-and-review.md) §3 の朝礼 (`team-standup-daily`、
毎朝 9:30) に「台帳のデイリー更新」を追加する (2026-08-20 neco 裁定。§0 の
「朝礼は書き換えない」を改める)。

- **証跡で裏付けられる完了だけを自動反映する**: マージ済み PR・完了済み delegation run・
  稼働確認済みサービス等の実測に対応する Memoria タスクの完了と、director case step の
  completed 化 (`PATCH /v1/director/cases/:caseId/steps/:stepId`)。
- **判断が要る更新は反映しない**: 削除・期限変更・優先順位・内容修正・新規目標は
  議題として提示し、人間の回答を待つ (定例または thread 返信)。勝手に反映しない。
- 反映した項目・提示した項目を朝礼カードに 1 件ずつ列挙する。

## 3. 受け入れ基準

- [ ] 30 分 tick でチームごとに巡回し、完了 run が step へ completed 反映される。
- [ ] 実行可能な pending delegate/implement step があればチーム帰属の実装セッションが
      起動し、step に run id が記録される。
- [ ] 同一 step の二重起動が起きない (triggered_by キーで冪等)。
- [ ] case 予算・チーム同時実行上限を超えて起動しない。超過・失敗・repo 未解決は
      direction 面の question カードへ上がる。
- [ ] 巡回エンジンは LLM を呼ばない。
- [ ] 朝礼が証跡ベースの台帳更新を行い、判断が要るものは反映せず提示する。
- [ ] workflow toggle `director` で巡回を停止できる。
