/**
 * 読み取り結果から、 登録できるか・何が足りないかを決める (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 欠けていれば定義してもらう / CC-DG-INV-01 / CC-DG-INV-09
 *
 * 登録に要るのはプロジェクト (registry で一意に解決できたもの)・ゴール文・受入条件 1 件以上。
 * Actio task と許可は任意 (許可は書かれていなければすべて不可)。
 */

import type { ExtractedGoal, GoalPermissions, PostField } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4bf23c08 */
import augurContract_7e14777e from './evaluate-draft.contract.js'; /* augur-inject:contract-predicate:5369a731 */

export interface CompleteGoalDraft {
  project: string;
  repoPath: string;
  goalText: string;
  acceptance: string[];
  actioTaskIds: string[];
  permissions: GoalPermissions;
}

export type DraftDecision =
  | { status: "complete"; goal: CompleteGoalDraft }
  | { status: "missing"; missing: PostField[]; projectUnresolved: boolean };

/**
 * extracted は extraction-guard を通した後のもの (null は読み取りに失敗した)。
 * resolved は extracted.project を project registry で一意に解決した結果。
 */
export function evaluateDraft(
  extracted: ExtractedGoal | null,
  resolved: { project: string; repoPath: string } | null,
): DraftDecision {
  const missing: PostField[] = [];
  const project = extracted?.project?.trim() ?? "";
  const goalText = extracted?.goalText?.trim() ?? "";
  const acceptance = [...new Set((extracted?.acceptance ?? []).map((item) => item.trim()).filter(Boolean))];
  if (!project || !resolved) missing.push("project");
  if (!goalText) missing.push("goal");
  if (acceptance.length === 0) missing.push("acceptance");
  if (missing.length > 0 || !extracted || !resolved) {
    return { status: "missing", missing, projectUnresolved: !!project && !resolved };
  }
  return {
    status: "complete",
    goal: {
      project: resolved.project, repoPath: resolved.repoPath, goalText, acceptance,
      actioTaskIds: [...new Set(extracted.actioTaskIds)], permissions: { ...extracted.permissions },
    },
  };
}
// @ts-expect-error augur-inject
evaluateDraft = contract(evaluateDraft, { ...augurContract_7e14777e, contractId: 'dg-C-1', mode: 'observe', sample: 1, where: 'src/daily-goal-run/draft-policy.ts:29', rule: 'contract-wrap', id: '7e14777e' }); /* augur-inject:contract-wrap:7e14777e */
