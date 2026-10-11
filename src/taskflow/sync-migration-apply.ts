/**
 * 人が承認した移行計画を Actio API の更新へ変える (spec/faq/actio-cc-task-project-sync.md §5)。
 *
 * 書き込みは Actio API (PATCH /api/tasks/:id) だけで、DB へ直接書かない。計画を作った後に
 * task が動いていることがあるので、更新の直前に読んだ現在値から PATCH の本文を作る。
 * 対象は M1〜M4。M5 (旧 md の作成) は §7 の判断が要るので含めない。M6 は照合ジョブが直す。
 */
import type { SyncMigrationPlan } from "./sync-migration-plan.js";
import type { MigrationActioTask } from "./sync-migration-types.js";

export type ApplyStep = "M1" | "M2" | "M3" | "M4";
export const APPLY_STEPS: readonly ApplyStep[] = ["M1", "M2", "M3", "M4"];

export type MigrationOperation =
  | { step: "M1"; task: string; op: "supersede"; superseded_by: string }
  | { step: "M2" | "M4"; task: string; op: "set_project"; project: string; expected_project: string | null }
  | { step: "M3"; task: string; op: "set_team"; team: string };

/** M1 は人が引き継ぎ関係を確かめた組 (review_required でない組) だけを適用する。 */
export function migrationOperations(plan: SyncMigrationPlan, steps: ReadonlySet<ApplyStep>): MigrationOperation[] {
  const ops: MigrationOperation[] = [];
  if (steps.has("M1")) for (const group of plan.M1.filter((item) => !item.review_required)) {
    for (const task of group.supersede) ops.push({ step: "M1", task, op: "supersede", superseded_by: group.keep });
  }
  if (steps.has("M2")) for (const move of plan.M2.moves) ops.push({ step: "M2", task: move.task, op: "set_project", project: move.to, expected_project: move.from });
  if (steps.has("M3")) for (const item of plan.M3.assign) ops.push({ step: "M3", task: item.task, op: "set_team", team: item.team });
  if (steps.has("M4")) for (const item of plan.M4.assign) ops.push({ step: "M4", task: item.task, op: "set_project", project: item.project, expected_project: null });
  return ops;
}

/**
 * 現在値から PATCH 本文を作る。計画の前提が崩れていれば (完了済み・別プロジェクトへ移動済み・
 * チーム設定済み) null を返し、その task は飛ばす。
 */
export function operationPatch(
  op: MigrationOperation, current: MigrationActioTask & { ownerId?: string; assigneeId?: string | null },
): Record<string, unknown> | null {
  if (op.op === "supersede") {
    if (current.status === "done" || current.status === "cancelled") return null;
    return { status: "cancelled", pluginPayload: { ...current.pluginPayload, superseded_by: op.superseded_by } };
  }
  if (op.op === "set_project") return current.projectId === op.expected_project ? { projectId: op.project } : null;
  if (current.teamId) return null;
  // チームのタスクには担当者が要る (ActioWorkflowClient.bindTeamLate と同じ規則)。
  return { teamId: op.team, ...(!current.assigneeId && current.ownerId ? { assigneeId: current.ownerId } : {}) };
}

export function parseApplySteps(value: string): Set<ApplyStep> {
  const steps = value.split(",").map((step) => step.trim()).filter(Boolean);
  for (const step of steps) if (!APPLY_STEPS.includes(step as ApplyStep)) throw new Error(`unsupported apply step: ${step}`);
  return new Set(steps as ApplyStep[]);
}
