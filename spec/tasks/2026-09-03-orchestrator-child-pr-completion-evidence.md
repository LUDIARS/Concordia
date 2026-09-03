---
task: orchestrator-child-pr-completion-evidence
project: Concordia
kind: 実装
status: delegated
created: 2026-09-03
delegation_run_id: 8fd1330c-b911-4773-ae7c-fa4d43a21ee7
memoria_task_id: 1944
---

# Orchestrator 委託の子 PR 成果証跡を許可する

## 目的

自身の feature branch を持たず実装を直下の子セッションへ委託する orchestrator run が、子セッションの PR がマージ済みなら completed 報告を完了として記録できるようにする。

## 完了条件

- [ ] 自身の feature branch がなく checkout 証跡が不足しても、`child_session_id` が著者の merged PR が 1 件以上あれば completed を受理する。
- [ ] 子 PR は直下の `child_session_id` だけを対象とし、孫以降を探索しない。
- [ ] 子 PR がない、または merged でない場合は既存どおり completed を拒否する。
- [ ] checkout を持つ既存 run の Git 証跡検証は変更しない。
- [ ] API 回帰テストを追加する。

## スコープ

- `spec/feature/delegation.md`
- `src/api/delegation.ts`
- `src/api/register-core.ts`
- `src/api/delegation-completion-evidence.test.ts`
