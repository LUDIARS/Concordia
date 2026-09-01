---
type: feature
title: "チーム朝礼と定例 — チームごとの定時報告と、人間同席のタスク棚卸し"
description: "チームごとに 1 本ずつ起動する Timer Delegation を 2 本追加する。朝礼 (毎朝 9:30) はチームの稼働状況と対応状況を 目標 面へカードとして報告し、証跡で裏付けられる完了だけを台帳 (Memoria タスク / director case step) へ毎日反映する。定例 (火・金 13:00) はタスクの棚卸し議題を提示して neco の返信を待ち、Memoria タスクと director case step へ反映するまでを 1 回とする。既存 cron が持たなかった「チームごとの fanout」を scheduler に追加する。"
service: concordia
domain: governance
tags:
  - teams
  - delegation
  - scheduler
  - discord
  - director
status: superseded
related:
  - feature/teams.md
  - feature/delegation.md
  - feature/director-goal-flow.md
  - feature/curiosity-walk.md
updated: 2026-09-01
---

# チーム朝礼と定例

> **休止 (2026-09-01 neco 指示)**: チーム簡素化 (teams.md §0.5) により、朝礼
> `team-standup-daily` と定例 `team-review-regular` の cron 登録を外した。
> delegation テンプレートは再開に備えて残す (cron には載せない)。

> 2026-08-17 neco 指示。「チームを作ったあと、毎朝これ (チームの稼働状況 / 対応状況の
> まとめ) をやりたい」「各チームでやる。これは朝礼」「タスクの確認と棚卸しをする定例も
> やろう。これは週 2 回で人間も混ざる」。

## 0. 原則

朝礼も定例も**新しい正本を作らない** (teams.md §0 と同じ)。既存の director case /
Memoria タスク / PR / Excubitor の状態を読んで束ねる。書き換えの境界は次の 2 本立て:

- **朝礼**: 証跡で裏付けられる完了だけを毎日反映する (2026-08-20 neco 裁定。
  当初の「朝礼は書き換えない」を改めた)。判断が要る変更は反映せず提示する。
- **定例**: 判断を伴う整理は定例で、**neco が決めたことだけ**を反映する。

## 1. チームごとの fanout

既存の Timer Delegation (`src/scheduler/cron-jobs.ts`) は 1 発火 = 1 invoke で、
チームという単位を持たなかった。チームごとに 1 本ずつ起動するため、ジョブ定義に
`fanout` を足す。

- `CronJobDefinition.fanout` は**戦略名**だけを持つ (現状 `"teams"` のみ)。対象の列挙は
  DB を引くため定義ファイルには置かず、`cron-scheduler` の `fanoutResolvers` が解決する。
  定義表を純粋なまま保ち、テストから DB を切り離すため。
- 対象の組み立ては `src/scheduler/cron-fanout.ts` の `buildTeamFanoutTargets`。
  `teams` テーブルの各行から `{ key: slug, args: {team_id, team_slug, team_name},
  options: {team: id} }` を作る。起動順を安定させるため slug 昇順。
- **チームへの帰属は `options.team`** で渡す。delegation service がこれを解決して
  `delegation_runs.team_id` に載せる (`args` に team_id を入れても帰属しない)。
- 失敗の分離: 1 チームの invoke が失敗しても残りのチームは起動する。
- **resolver 未登録の fanout ジョブは起動しない。** 宛先不明のまま 1 本だけ走ると、
  チーム宛のはずの朝礼が宛先無しで実行されてしまうため、黙って単発起動へ縮退させない。
- 対象 0 件 (チーム未作成) なら 1 度も invoke しない。

## 2. チーム面へのカード投稿

朝礼の報告と定例の開始通知をチーム面へ載せるため、面へ本文付きカードを出す経路を作る。

| 種別 | 面 | 用途 |
|---|---|---|
| `standup` | 目標 | 朝礼の報告 (稼働 / 対応 / ズレ / 今日効く 3 点) |
| `meeting` | direction | 定例の開始通知 (件数と入口だけ。議題本文は載せない) |

- 入口は `POST /v1/teams/:id/cards {kind, title, body}` (id / slug の両方で引ける)。
  **種別は上表の固定集合に限る** — 任意の面へ任意本文を投げられる口にしない。
- API は検証して `team.card_requested` を emit するだけ。実際の投稿は Discord bot 側の
  `src/discord/team-post-card.ts` が行う (既存の team-audit-card と同じ非同期経路)。
- 投稿先の決定は `team-card-routing.ts` に委ねる。**面が未プロビジョニングなら投稿せず
  スキップ**し、エラーにしない (面の準備前に朝礼が走っても cron を落とさない)。
- 本文は embed description 上限に合わせて切り詰め、**切り詰めた事実を本文に残す**。
- カードは `allowedMentions: {parse: []}` で送る (報告本文に `@` が混ざっても撒かない)。

## 3. 朝礼 (`team-standup-daily`)

毎朝 **9:30 JST**、チームごとに 1 本。先行する日次ジョブ (脆弱性 5:10 / deps 7:10 /
Steam 7:40 / Vultus 8:20 / カイゼン 9:00) の後ろに置き、朝礼がそれらの結果を引用できる
ようにする。

報告する内容:

- **稼働**: チームの repos に対応する Excubitor サービスの state / health / 24h 稼働率 /
  最後に落ちた時刻。落ちているものは `depends_on` を辿り、どの依存で機能が通らないかまで。
- **対応**: director case の step 進捗、滞留 PR、未完了タスク、前日のセッションとコスト。
- **ズレ**: 実態はもう終わっているのに step / タスクが未完了のまま、という食い違い。
  朝礼で最も価値がある指摘なので必ず見る。
- **今日効く 3 点**: 具体的な行動。裁定待ちなら何を誰が決めれば動くのかを書く。

報告に続けて、**台帳のデイリー更新**を行う (2026-08-20 neco 裁定):

- 証跡 (マージ済み PR / 完了済み delegation run / 稼働確認) で裏付けられる完了だけを
  反映する: Memoria タスクの完了、director case step の completed 化
  (`PATCH /v1/director/cases/:caseId/steps/:stepId`)。
- 削除・期限変更・優先順位・内容修正・新規目標の起案など判断が要る更新は反映せず、
  議題として提示して人間の回答を待つ (定例または thread 返信)。
- 反映した項目・提示した項目をカードに 1 件ずつ列挙する。

制約:

- 判断が要る整理は定例で人間と決める (勝手に反映しない)。
- 取れなかった数字は「取得できず」と明記し、推測で埋めない。
- チーム設定が `visibility: private` なら、対外に出せない固有名をカードに書かない。

## 4. 定例 (`team-review-regular`)

**火・金 13:00 JST**、チームごとに 1 本。**議題提示で終わらず、neco の返信を反映する
まで**が 1 回分 (2026-08-17 neco 裁定)。

進め方:

1. 棚卸しの材料を集める (参照先は朝礼と同じ)。
2. 議題を 5 分類で作る: 実態は終わっているのに未完了 / 止まっている / 裁定待ち /
   重複・陳腐化 / どの目標にも紐づいていない。各項目に `A-1` 形式の短い番号を振る。
3. 議題は**定例セッションの Discord thread へ投稿する**。thread への平文返信はそのまま
   セッションへ inject されるため (`discord/ingress.ts`)、ここが人間と混ざる場になる。
   direction 面へは `meeting` カードで入口だけ出す。
4. neco の返信どおりに反映する: Memoria タスク (完了 / 削除 / 期限変更 / 内容修正)、
   director case step (`PATCH /v1/director/cases/:caseId/steps/:stepId`)。
5. 何をどう変えたかを 1 件ずつ列挙して報告する。未反映が残っていれば明示する。
6. 返信が無いまま長時間経過したら、議題を残して「未実施」で終わる。**勝手に反映しない。**

原則:

- **neco が決めていないことを反映しない。** 明らかな事実誤り (既にマージ済み等) でも、
  反映前に議題として出して同意を取る。
- 反映は 1 件ずつ確認できる形で行い、一括変更しない。
- コード修正・commit・push・PR 作成・サービスの起動停止はしない。台帳の整理だけ。

## 5. 通知

両テンプレとも parttimer の規約どおり完了時に管理者へメンションする
(`MENTION_ADMIN_STEP`、delegation.md)。定例はさらに**議題提示の時点でも**メンションする
— 人間の同席が要る回なので、完了時だけの通知では間に合わないため。

## 6. 決めていないこと

- セッション forum は現状グローバル (`session_forum_id`) のままで、チームの
  セッションフォーラム面へは振り分けていない。定例 thread も同じ扱いになる。
  チーム面への振り分けは teams.md の別項目として残る。
- 朝礼のカードは毎日 1 枚積む (1 メッセージ更新型にはしていない)。日々の変化を
  遡れることを優先した。
