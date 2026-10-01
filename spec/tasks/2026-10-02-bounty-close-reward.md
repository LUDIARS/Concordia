---
task: 2026-10-02-bounty-close-reward
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 3/5 — 反映確認・デプロイ通知・報奨と個人残高

設計正本: `spec/feature/bug-bounty.md` §7・§11 (`SPEC-BOUNTY-CLOSE` / `SPEC-BOUNTY-REWARD` / `SPEC-BOUNTY-BALANCE`)。
価値 UX-CC-W7 / シナリオ UX-CC-S8。ドメイン `bug-bounty` (支援)。前提: `2026-10-02-bounty-triage-fix` がマージ済み。
2026-10-02 neco 指示「(結果は) プロジェクトデプロイ通知で通知される」「報酬として AI 予算をあげる」「個人」「(本社は) 対象外」。

## 目的

修正の反映を確認した時点で報告を閉じ、デプロイ通知と受付口へ結果を返し、報告者個人の AI 予算 (個人残高) を増やす。
個人残高は、所属の日次 budget を超えた後の消費に使える。

## 完了条件

- [ ] 最初に確認する: Revisor の変更一覧が PR の識別子を返すか。返さなければ手動クローズだけを実装し、その旨を spec と PR に書く。
- [ ] `service.deployed` の処理で、変更に `fix_pr` を含む報告を `deployed` にする。同じデプロイは 1 回だけ (既存の台帳)。
- [ ] デプロイ通知に「解決したバグ報告」の節 (報告 id・公開用の題名・公開名)。本文由来の mention は許可しない。
      組み立ては service-deployed-notify が持ち、bug-bounty は port で答える。
- [ ] 受付口への結果の返信 (Discord は構造化フィールドの mention、セッションは inject)。届かなくても反映と報奨は取り消さない。
- [ ] `/bug close` (権限者・根拠必須)。Actio のタスクが done になっても自動では閉じず、権限者へ 1 回だけ知らせる (CC-BOUNTY-INV-09)。
- [ ] 報奨の判定を純関数で持つ (採用・重複でない・自己起因でない・受取人あり・子会社所属)。`bounty_balance_ledger` に
      `grant` を 1 報告 1 回 (CC-BOUNTY-INV-04 / 05)。判定が覆ったら未使用ぶんを上限に `revoke`。
- [ ] 子会社の日次 budget 超過時、依頼者の個人残高が正ならその依頼者のセッションだけ通す。超過中の消費を `debit` する
      (セッションの累積トークンの正の差分、`(session_id, date_iso)` 単位で二重に引かない)。
- [ ] 全体の日次 budget (停止スイッチ) が超過中は通さない。残高は負にしない (CC-BOUNTY-INV-06)。
- [ ] 子会社の budget 判定が複数経路にあれば洗い出し、すべてに同じ port を通す。洗い出した経路を PR に書く。
- [ ] `/bug balance` (応答は本人にだけ)。設定 `bounty.reward_tokens.s1〜s4` (既定は spec §7.2 の提案値)。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/bounty/`、`src/db/bounty-*-repo.ts`、`src/db/schema.ts`、`src/api/bounty*.ts`、`src/discord/bounty-*`、`src/discord/commands/bug.ts`
- `src/deploy/` (通知本文の節の追加と port の配線)、`src/cost/` と budget を参照する chat / delegation の経路 (残高の判定の port だけ)
- 設定定義、`tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md`、`spec/feature/service-deployed-notify.md`、`spec/feature/cost-observability.md`
