---
task: 2026-10-02-personal-budget-core
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# 個人の AI 予算 A — 台帳・月間分と報酬分の消費・本社の調整・WebUI

設計正本: `spec/feature/personal-ai-budget.md` §3・§4 (種類 `manual` と port)・§6・§7・§8・§10・§11
(`SPEC-PBUDGET-CONSUME` / `SPEC-PBUDGET-REWARD` / `SPEC-PBUDGET-ADJUST` / `SPEC-PBUDGET-VIEW`)。
価値 UX-CC-W8 / シナリオ UX-CC-S9。ドメイン `personal-ai-budget` (支援)。
2026-10-02 neco 指示「予算だけど月間分と報酬分で分けて、月間予算から先に消費する」「本社で『〇〇に報酬』で調整できるようにする」(〇〇は人)。

## 目的

子会社の個人ごとに月間分と報酬分の予算を持ち、月間分から先に消費する。本社の権限者が特定の人の報酬分を増減でき、
本人と本社が残高と履歴を確認できる。他ドメイン (バグバウンティ・技術相談の公開) が報奨を依頼する port を用意する。

## 完了条件

- [ ] `personal_budget_people` / `personal_budget_monthly_usage` / `personal_budget_session_seen` / `personal_budget_ledger` と
      `subsidiaries.personal_monthly_token_budget` を migration で作る (番号は未マージの並行ブランチも見て採番する)。
- [ ] 割り当て (月間分 → 報酬分) と払い出しの判定 (spec §3 の表) を純関数で持つ (CC-PBUDGET-INV-01 / 02 / 03)。
- [ ] 消費の計上: 依頼者を持つセッションの累積トークンの正の差分。baseline で二重計上を防ぐ (CC-PBUDGET-INV-05)。
- [ ] 払い出しを止める既存の経路 (全体・子会社の budget を見ている chat / delegation の経路) を洗い出し、すべてに同じ port を通す。
      洗い出した経路を PR に書く。止めるときは理由と報酬分の残りを依頼者へ返す。
- [ ] 委託の子セッションが親の依頼者を引き継いでいるかを確認し、結果を PR に書く。引き継いでいなければ実装せず報告する。
- [ ] 報奨の port: 種類・根拠・受取人を受け、加算量と一意性 (`(kind, source_ref)`) を決める。本社所属・個人を特定できない場合は
      付けずに理由を記録する (CC-PBUDGET-INV-04 / 07)。取り消し (`revoke`) は未使用ぶんを上限にする。
- [ ] 本社 guild の `/reward user tokens reason` (権限者だけ・理由必須・負は 0 まで・本社メンバーは受けない)。
      複数の子会社に居る人は `subsidiary` を求める (CC-PBUDGET-INV-06)。
- [ ] `/budget` (本人にだけ応答): 今月の月間分、報酬分の残り、直近の履歴 (CC-PBUDGET-INV-08)。
- [ ] 付与・調整を本人へ知らせる。届かなくても付与は取り消さない。
- [ ] WebUI「個人の AI 予算」ページと API (spec §7)。一覧はページングし、台帳は個人単位で取る。月間分の上限の設定と調整ができる。
- [ ] 設定 `personal_budget.reward.*` (既定は spec §5 の提案値)。
- [ ] 月間分の上限が 0 (既定) の個人では、現状の払い出しの動きが変わらないことをテストで固定する。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。
- [ ] 画面はスクリーンショットを開いて確認する。未確認ならその旨を PR に書く。

## スコープ (編集可ディレクトリ)

- `src/personal-budget/`、`src/db/personal-budget-*-repo.ts`、`src/db/schema.ts`、`src/api/personal-budget*.ts`、`src/api/register-core.ts`、
  `src/bootstrap/core.ts`、`src/discord/commands/reward.ts`、`src/discord/commands/budget.ts`、Bot のコマンド登録の配線
- `src/cost/` と budget を参照する chat / delegation の経路 (port を通す箇所だけ)、子会社の設定 API と画面 (月間分の既定値)
- `web/src/pages/PersonalBudget*.tsx`、`web/src/api.ts`、WebUI のルーティングとナビゲーション、設定定義
- `tests/`、`cc.acceptance.json`、`spec/feature/personal-ai-budget.md`、`spec/feature/cost-observability.md`

## 2026-10-03 統合検証引継ぎ

同じ元Actioとhuman:2026-10-03:merge-cc-ready-prsに基づく継続。
現在の人間指示はlocal main起点・マージまで・単体登録回帰/memory migration/型許可で、
当初の未実行/PR終了指定を上書き。親がclaim/再審査/merge/反映を担当する。
main75f952daを統合、PB migrationを127へ。旧123〜126本文/凍結値と双方台帳を保持。
backend35files394件・web2files7件合格 (重複再実行を除く)。最初の失敗と原因、追補taskの区別、
復旧/未決政策/未実施は personal-ai-budget.md §14を参照。
画面スクリーンショット・実DB/Discord通知は未確認。設定値の人間承認や未回答仕様判断を捏造しない。
