---
type: feature
title: "ディレクターワークフロー — 現場を回す人のワークロード定義とタスク整理"
description: "「現場を回す人 (ディレクター)」の定常ワークロードを 1 つのワークフロー概念として定義する。Memoria から関連する未完了タスクを引く delegation (director-task-pull) と、それを使ってチームごとにタスク整理を行う delegation (director-task-organize、毎日 10:00) を用意し、整理結果を director case step として巡回 (director-patrol) が実行できる形へ落とす。step 追加 API とタスクボード面カードを追加する。"
service: concordia
domain: governance
tags:
  - director
  - teams
  - delegation
  - taskflow
  - scheduler
  - memoria
status: implemented
related:
  - feature/director.md
  - feature/director-patrol.md
  - feature/team-standup-and-review.md
  - feature/teams.md
updated: 2026-08-20
---

# ディレクターワークフロー — 現場を回す人のワークロード

> 2026-08-20 neco 指示。「ディレクターワークフローという概念を用意する。現場を回す人の
> ワークロードです。Memoria のタスクから関連する未完了タスクを引っ張る Delegation と、
> それを使ってタスク整理を行うディレクターワークフローを用意」。

## 0. 概念 — ディレクターの 1 日

ディレクターは判断する LLM ではない (director.md §0)。現場 (チーム) を回すための
**定常ワークロード**であり、次のループで構成される。workflow toggle は `director` に属する。

| 時刻 | 工程 | 実体 |
|---|---|---|
| 9:30 | 朝礼: 稼働・対応の報告 + 証跡ベースの台帳更新 | `team-standup-daily` (team-standup-and-review.md §3) |
| 10:00 | **タスク整理**: 関連未完了タスクを引き、目標へ紐付けて実行可能な形へ落とす | `director-task-organize` (本 spec §2) |
| 30 分ごと | 巡回: 実行可能 step の実装セッション起動と run 反映 | director-patrol (director-patrol.md §1) |
| 火・金 13:00 | 定例: 判断を伴う棚卸しを人間と行う | `team-review-regular` |
| 随時 | エスカレーション: 人間の判断が要るものを設問・カードで上げる | ask-bridge / question カード |

タスクの正本は Memoria、目標の正本は director case であり、ワークフローはどちらも
複製しない。整理の成果は「director case への step 追加」と「証跡ある完了の反映」だけで、
判断を伴う変更は人間へ提示する。

## 1. タスク取得 delegation (`director-task-pull`)

Memoria から**関連する未完了タスク**を引く再利用可能な部品。単体でもドロップダウンから
呼べる (「このテーマの残タスクを出して」)。

- 入力: `topic` (必須: プロジェクトコード / カテゴリ / キーワード)、`limit` (任意)。
- 手順: Memoria API (`GET /api/tasks`、ポートは Excubitor catalog で解決) から取得し、
  `status != done` かつ topic に関連するもの (title / details / category の全文一致、
  プロジェクトコード・リポ名の別名も考慮) を絞る。
- 出力: 正規化した一覧 (id / title / category / due_at / 関連根拠) を Markdown 表 +
  JSON ブロックで報告する。**読み取り専用** — タスクの書き換え・削除はしない。
- 取得手順の正本はこのテンプレートであり、他テンプレートは同じ手順定義
  (seed.ts の共有定数) を埋め込んで使う。

## 2. タスク整理 delegation (`director-task-organize`)

チームごとに毎日 10:00 JST (朝礼の後) に起動する Timer Delegation (`fanout: "teams"`)。
ドロップダウンからの随時起動も可。§1 の取得手順で引いたタスクを、次の 4 分類で整理する。

1. **実行可能**: チームの目標 (director case) に紐づき、AI が実装できる — 該当 case へ
   `delegate` step を追加する (`POST /v1/director/cases/:caseId/steps`)。追加された step は
   巡回 (director-patrol) が拾って実装セッションを起動する。1 タスク 1 step、既存 step と
   重複させない (title / task 参照で突き合わせる)。
2. **実態完了**: 証跡 (マージ済み PR / 完了 run / 稼働確認) がある — Memoria タスクを
   done にし、対応する step を completed にする (朝礼の台帳更新と同じ境界)。
3. **判断待ち**: 削除・期限変更・優先順位・内容修正・新規目標の起案が要る — 反映せず
   設問として提示し、人間の回答を待つ。
4. **浮いている**: どの目標にも紐づかない — 一覧にして提示する (勝手に case を作らない。
   新規 case の起案は人間の判断)。

整理結果はチームの **タスクボード面**へ `task-kanban` カードとして投稿する
(`POST /v1/teams/:id/cards {kind:"task-kanban"}`。面が未プロビジョニングならスキップ)。

## 3. 追加する機構

- **step 追加 API**: `POST /v1/director/cases/:caseId/steps` (単一 step)。sequence は
  末尾採番 (repo transaction 内で MAX+1)。closed (全 step が terminal) かどうかは問わない —
  目標が続く限り case は生きている。
- **カード種別 `task-kanban`**: team-card-routing に予約済みだった種別の投稿元を実装する。
  API の受付種別に加え、event 契約と色を追加する。
- **cron**: `director-task-organize-daily` (毎日 10:00 JST、fanout teams)。

## 4. 受け入れ基準

- [ ] `director-task-pull` が topic 指定で未完了タスクの正規化一覧を返す (書き換えなし)。
- [ ] `director-task-organize` が 4 分類で整理し、実行可能タスクを step 追加まで落とす。
- [ ] 追加された step を director-patrol が実行可能候補として扱える (pending delegate)。
- [ ] 判断待ち・浮いているタスクは反映されず、人間へ提示される。
- [ ] `POST /v1/director/cases/:caseId/steps` が末尾 sequence で step を追加する。
- [ ] `task-kanban` カードがタスクボード面へ投稿される (未プロビジョニングはスキップ)。
- [ ] cron が毎日 10:00 にチームごとへ fanout する。
