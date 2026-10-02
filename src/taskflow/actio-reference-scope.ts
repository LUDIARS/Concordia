/** @implements CC-TASK-LINKED-FOLLOWUP — 指示参照として関連付けられる Actio タスクの範囲 (純粋関数) */
import type { ActioBinding } from "./actio-binding.js";
import { taskTeamInScope } from "./actio-team-selection.js";

/** taskflow v3 以前にタスク md から登録された旧来タスクの source。参照専用で作業候補にはしない。 */
export const ACTIO_LEGACY_REFERENCE_SOURCES: readonly string[] = ["cc-taskmd"];

export interface ReferenceCandidate {
  projectId: string | null;
  ownerId: string;
  teamId: string | null;
  source: string | null;
}

/**
 * 旧来タスクを参照として受け入れるか。project と owner は binding と一致し、team は binding の範囲内か、
 * team を持たないなら owner 一致で足りる (依存タスクの読み込みと同じ規則)。v3 タスクの判定はここでは扱わない。
 */
export function isLegacyReferenceInScope(binding: Pick<ActioBinding, "projectId" | "ownerId" | "teamId" | "teamCandidates">, task: ReferenceCandidate): boolean {
  if (task.source === null || !ACTIO_LEGACY_REFERENCE_SOURCES.includes(task.source)) return false;
  if (task.projectId !== binding.projectId || task.ownerId !== binding.ownerId) return false;
  return task.teamId === null || taskTeamInScope(binding, task.teamId);
}
