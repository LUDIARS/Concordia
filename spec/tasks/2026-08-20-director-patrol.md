---
task: director-patrol
project: Concordia
kind: 実装
created: 2026-08-20
memory_links:
  - spec/feature/director-patrol.md
  - spec/feature/director-goal-flow.md
  - spec/feature/team-standup-and-review.md
---
# Director 巡回 (30 分チーム監視 + 実装セッション自動起動) と朝礼デイリー更新

## 目的

2026-08-20 neco 指示: 「動作させているチームの様子を 30 分おきに確認し、目標に対して
残タスクで実行できるものがあれば、チームセッションを作成して実装できるようにする
(ディレクター判断)。人間の判断が必要なものは人間に聞く。タスクリスト (Memoria) と
目標の更新を毎日、朝礼と一緒にやる。起動されたセッションは最初に人間の担当者へ
メンションする」を spec/feature/director-patrol.md として設計し、フルセットで実装する。

## 完了条件

- 30 分 tick の director-patrol が workflow binding `director` として起動し、
  チームごとに巡回する (`src/director/patrol.ts` + `patrol-runtime.ts`)。
- 完了 run の step 反映 / 失敗 run の blocked 化 / 実行可能 step の delegation 起動
  (options.team + goal_and_go、triggered_by で冪等)。
- 予算・同時実行上限を守り、超過・失敗・repo 未解決は direction 面の question カード。
- 起動セッションの prompt に担当者への最初メンション手順を含む。
- 朝礼テンプレ (team-standup-daily) が証跡ベースの台帳デイリー更新を行う。
- Vitest でカバーする。

## スコープ (編集可ディレクトリ)

- `src/director/` `src/workflow/` `src/discord/team-post-card.ts` `src/events.ts`
- `src/delegation/seed.ts` `src/bootstrap/core.ts`
- `spec/feature/` `spec/tasks/` `spec/domains/`
