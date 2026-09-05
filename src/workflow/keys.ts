/**
 * ワークフロー有効化フラグのキー定義。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W1
 *
 * Concordia は「セッションコントロール基盤」と「その上のワークフロー群」を
 * 個別に有効/無効へ切り替えられる。 ここはその識別子と、 DB / env の名前解決だけを
 * 持つ (値の解決は toggles.ts、 実体の起動/停止は binding-registry.ts)。
 */

export const WORKFLOW_KEYS = ["task", "test", "reaction", "review", "daily", "morning", "cost", "director", "curiosity", "inbox", "github"] as const;

export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

/**
 * 新規の外部入力ワークフローは、運用者が明示的に有効化するまで閉じておく。
 * @implements spec/feature/github-issue-workflow.md — 契約
 */
export function workflowDefaultEnabled(key: WorkflowKey): boolean {
  return key !== "github";
}

export function isWorkflowKey(value: string): value is WorkflowKey {
  return (WORKFLOW_KEYS as readonly string[]).includes(value);
}

/** 人間向けの表示名 (409 の理由文・設定 UI で使う)。 */
export const WORKFLOW_LABELS: Record<WorkflowKey, string> = {
  task: "TaskWorkflow (タスク駆動・decompose・residual)",
  test: "TestWorkflow (テストフォーラム・テスト候補)",
  reaction: "ReactionWorkflow (絵文字リアクション)",
  review: "レビュー通知・Revisor 連携",
  daily: "日次レビュー / cron スケジューラ",
  morning: "朝タスク (morning-tasks の自動起動)",
  cost: "コスト集計・予算通知",
  director: "Director 巡回 (休止中 — 2026-09-01 neco 指示で散歩セッションへ置換)",
  curiosity: "散歩セッション (ランダムなタイミングで 2 素材を並べて 1 問だけつぶやく)",
  inbox: "承認インボックスの朝夕ダイジェストと放置催促",
  github: "GitHub Issue ワークフロー (Cc ラベル → 修正 → 審査 → GitHub PR)",
};

/** schema_meta 上の設定キー。 */
export function workflowSettingKey(key: WorkflowKey): string {
  return `admin.workflow.${key}.enabled`;
}

/** DB 未設定時のフォールバック env 名。 */
export function workflowEnvName(key: WorkflowKey): string {
  return `CONCORDIA_WORKFLOW_${key.toUpperCase()}_ENABLED`;
}
