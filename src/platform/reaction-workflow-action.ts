/**
 * リアクションワークフローのアクション語彙 (正本)。
 *
 * 実装 (`reaction-workflow.ts`) から切り離してあるのは、 権限の対応表
 * (`reaction-workflow-capability.ts`) とスキル写像 (`reaction-workflow-skill.ts`) が
 * この語彙だけを必要とするため。 実装側から型を借りると循環依存になり、
 * 依存検査 (no-circular) が落ちる。
 */

/**
 * 全アクションの一覧 (API / GUI の検証・選択肢に使う)。
 * 並び順は設定 GUI の表示順であり、 `WORKFLOW_EMOJI` の宣言順と一致させる
 * (reaction-workflow.test.ts が突き合わせる)。
 */
export const WORKFLOW_ACTIONS = [
  "context",
  "start-impl",
  "enumerate-remaining",
  "memoria-remaining",
  "status-check",
  "repo-memory-good",
  "memoria-note",
  "memoria-task",
  "repo-memory-bad",
  "defer-impl",
  "force-enter",
  "delegate-task",
  "channel-rename",
  "reschedule-non-goal",
  "run-goal-tasks",
  "handoff-document",
  "resume-work",
  "submit-pr",
  "list-local-prs",
  "merge-pr",
  "sync-project-main-after-merge",
  "add-as-workflow",
  // 設計 §9.2 (C-7): ドメイン情報の投稿 (📑) と対話レビューの開始 (🪬)。
  "domain-report",
  "domain-review",
] as const;

export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

/** action 文字列が有効な WorkflowAction か。 */
export function isWorkflowAction(v: unknown): v is WorkflowAction {
  return typeof v === "string" && (WORKFLOW_ACTIONS as readonly string[]).includes(v);
}
