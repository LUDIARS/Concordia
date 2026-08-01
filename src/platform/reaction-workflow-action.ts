/**
 * リアクションワークフローのアクション語彙 (型だけ)。
 *
 * 実装 (`reaction-workflow.ts`) から切り離してあるのは、 権限の対応表
 * (`reaction-workflow-capability.ts`) がこの語彙だけを必要とするため。 実装側から
 * 型を借りると capability ⇄ workflow の循環依存になり、 依存検査 (no-circular) が落ちる。
 */

export type WorkflowAction =
  | "start-impl"
  | "enumerate-remaining"
  | "memoria-remaining"
  | "status-check"
  | "repo-memory-good"
  | "repo-memory-bad"
  | "memoria-note"
  | "memoria-task"
  | "defer-impl"
  | "force-enter"
  | "delegate-task"
  | "channel-rename"
  | "reschedule-non-goal"
  | "run-goal-tasks"
  | "handoff-document"
  | "resume-work"
  | "merge-pr"
  | "sync-project-main-after-merge"
  | "add-as-workflow";
