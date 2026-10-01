---
task: 2026-10-02-bounty-close-reward
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 3/5 — 反映確認・デプロイ通知・報奨の依頼

設計正本: `spec/feature/bug-bounty.md` §7・§11 (`SPEC-BOUNTY-CLOSE` / `SPEC-BOUNTY-REWARD`)。報奨の台帳と加算量は
`spec/feature/personal-ai-budget.md` が持つ。価値 UX-CC-W7 / シナリオ UX-CC-S8。ドメイン `bug-bounty` (支援)。
前提: `2026-10-02-bounty-triage-fix` と `2026-10-02-personal-budget-core` がマージ済み。
2026-10-02 neco 指示「(結果は) プロジェクトデプロイ通知で通知される」「報酬として AI 予算をあげる」「個人」「(本社は) 対象外」。

## 目的

修正の反映を確認した時点で報告を閉じ、デプロイ通知と受付口へ結果を返し、報告者個人の報酬分への加算を依頼する。

## 完了条件

- [ ] 最初に確認する: Revisor の変更一覧が PR の識別子を返すか。返さなければ手動クローズだけを実装し、その旨を spec と PR に書く。
- [ ] `service.deployed` の処理で、変更に `fix_pr` を含む報告を `deployed` にする。同じデプロイは 1 回だけ (既存の台帳)。
- [ ] デプロイ通知に「解決したバグ報告」の節 (報告 id・公開用の題名・公開名)。本文由来の mention は許可しない。
      組み立ては service-deployed-notify が持ち、bug-bounty は port で答える。
- [ ] 受付口への結果の返信 (Discord は構造化フィールドの mention、セッションは inject)。届かなくても反映と報奨は取り消さない。
- [ ] `/bug close` (権限者・根拠必須)。Actio のタスクが done になっても自動では閉じず、権限者へ 1 回だけ知らせる (CC-BOUNTY-INV-09)。
- [ ] 報奨を依頼してよいかの判定を純関数で持つ (採用・重複でない・自己起因でない・受取人あり)。満たせば個人の AI 予算の port へ
      種類 `bounty`・報告 id・深刻度・受取人を渡す。台帳を直接書かない。判定が覆ったら取り消しを依頼する。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/bounty/`、`src/db/bounty-*-repo.ts`、`src/api/bounty*.ts`、`src/discord/bounty-*`、`src/discord/commands/bug.ts`
- `src/deploy/` (通知本文の節の追加と port の配線)、`src/bootstrap/core.ts` (port の組み立て)
- `tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md`、`spec/feature/service-deployed-notify.md`
