---
task: reaction-workflow-readiness
project: Concordia
kind: 実装
status: delegated
created: 2026-07-16T00:00:00.000Z
delegation_run_id: 44d316e5-b8fc-472b-ae5d-9be0821b9fcd
memoria_task_id: 522
actio_task_id: null
memory_links:
  - E:/Document/Ars/.wt-Concordia-rwf-confirm-incidents/spec/plan/problem_logs/2026-07-16-reaction-workflow-empty-allowlist.md
---
# Reaction-Workflowの認可設定と稼働可視性を修正する

## 目的

Reaction-WorkflowがONでもプラットフォームallowlistが空なら全拒否される状態を、人間が明確に認識・設定できるようにする。deny-by-defaultとID完全一致は維持し、無言のallow-allフォールバックは導入しない。

## 完了条件

- Discord / Slackの発火allowlistを、ハードコードせず正本となる設定経路から供給できる。
- Reaction-WorkflowがONかつallowlist空のとき、管理APIまたは設定画面で「実行可能ユーザーなし」と分かる非機密のreadiness情報が表示される。
- ONかつallowlist空の状態を起動時または設定変更時に明示的に警告する。
- enabled+empty、allowed、unauthorizedの自動テストを追加する。
- Reaction-Workflowの既存の絵文字写像、dedup、受付replyを壊さない。
- `npm run lint`、関連vitest、`npm run build`が成功する。
- 変更を1 PRとして作成する。

## スコープ

- `src/shared/reaction-workflow-auth.ts`
- `src/admin/` と管理API / 設定画面のReaction-Workflow関連
- `src/bootstrap/core.ts` の認可設定注入
- 関連テストと仕様更新

## 制約

- worktreeからサービスを起動・再起動しない。
- ユーザーIDをソースへ直書きしない。
- 空設定をallow-allとして扱わない。
- 隣接するReaction-Workflowアクションの挙動変更は行わない。
