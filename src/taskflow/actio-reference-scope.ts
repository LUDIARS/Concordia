/** @implements CC-TASK-LINKED-FOLLOWUP — 指示参照として関連付けられる Actio タスクの範囲 (純粋関数) */
import type { ActioBinding } from "./actio-binding.js";
import { taskTeamInScope } from "./actio-team-selection.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:aa6c8277 */
import augurContract_66bb49ed from './actio-reference-scope.contract.js'; /* augur-inject:contract-predicate:ad56d278 */

export interface ReferenceCandidate {
  projectId: string | null;
  ownerId: string;
  teamId: string | null;
  source: string | null;
}

/**
 * taskflow v3 以外のタスク (旧来の cc-taskmd、Cc の不具合報告 cc-command、Memoria 取り込み、手入力など) を
 * 参照として受け入れるか。範囲は project・owner・team で決め、source では決めない (2026-10-23 不具合
 * 162bc3a6: Cc プロジェクトの cc-command 26 件と別プロジェクト由来の memoria-import が全件 403 になっていた)。
 * project と owner は binding と一致し、team は binding の範囲内か、team を持たないなら owner 一致で足りる
 * (依存タスクの読み込みと同じ規則)。参照専用で、作業候補・状態更新には使わない。v3 タスクはここでは扱わない。
 */
export function isReferenceInScope(binding: Pick<ActioBinding, "projectId" | "ownerId" | "teamId" | "teamCandidates">, task: ReferenceCandidate): boolean {
  if (task.projectId !== binding.projectId || task.ownerId !== binding.ownerId) return false;
  return task.teamId === null || taskTeamInScope(binding, task.teamId);
}
// @ts-expect-error augur-inject
isReferenceInScope = contract(isReferenceInScope, { ...augurContract_66bb49ed, contractId: 'actio-link-C-1', mode: 'observe', sample: 1, where: 'src/taskflow/actio-reference-scope.ts:19', rule: 'contract-wrap', id: '66bb49ed' }); /* augur-inject:contract-wrap:66bb49ed */
