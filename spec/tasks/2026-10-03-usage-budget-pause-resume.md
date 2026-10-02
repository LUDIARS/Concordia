---
task: 2026-10-03-usage-budget-pause-resume
project: Concordia
kind: 実装
created: 2026-10-03
memory_links: []
actio_reference: actio:c647d511-f24f-4700-950a-72ec3870542f
---
# 月次予算の途中停止・再開・助けに入った人への付け替え・コスト倍率

設計正本: `spec/feature/usage-budgets.md` §3.1 §3.2 §5.2 §5.3、`spec/feature/departments.md` §9.7。
タスク本文は Actio (`actio:c647d511-f24f-4700-950a-72ec3870542f`) を参照する。

## 分解

1. 倍率: 部署設定 `budget.cost_multiplier`、役職ごとの倍率表 (migration 124)、換算 (`chargedTokens`)。
2. 帰属: 時刻つきの消費 (`usage-timeline.ts`) と inject の作者から、指示を出した人ごとに分ける (`usage-attribution.ts`)。
3. 集計: tracker を倍率込み・人ごとにし、ツール実行ごとの判定用にキャッシュする。
4. 途中停止: ハーネスの gate に予算の判定 (`UsageBudgetGate`)、中断の記録、admin stop と共有の終了手順 (`stopWrappedSession`)。
5. 再開: 見回りで「再開」を出す (`offerBudgetResumes`)、Discord のボタン、再開 API と `claude --resume` の起動 (`planBudgetResumeLaunch`)。
6. API と WebUI: 倍率表・中断の一覧・再開、部署設定と社員名簿の入力欄。

## 完了条件

- [x] 1〜6 の実装と、同じ変更での単体・API テスト、Augur 契約 `budget-C-1`〜`budget-C-5`。
- [x] spec (usage-budgets.md / departments.md)、`cc.acceptance.json`、Augur テスト台帳。
- [ ] 反映後、相談課 2 部署の倍率 0.25 を PATCH で入れる (親セッション)。
- [ ] 反映後、予算を使い切ったセッションが止まり、予算を戻すと「再開」から続きが動くことを確かめる (人)。
