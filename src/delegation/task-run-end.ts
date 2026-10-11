/**
 * 終わった委託 run を、その run が結びついた Actio task の runs[] に閉じて記録する
 * (spec/feature/task-workflow-v3.md §run と task)。記録は補助情報なので、失敗しても
 * run の終了処理は止めない。次の run の開始時に未終了の記録は superseded で閉じられる。
 */
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { TaskStore } from "../taskflow/store.js";
import { TASKFLOW_REFERENCE } from "./work-key.js";

function runTaskTarget(run: Pick<DelegationRunRow, "args_json">): { reference: string; repoPath: string } | null {
  let args: unknown;
  try { args = JSON.parse(run.args_json); } catch { return null; }
  if (!args || typeof args !== "object") return null;
  const { taskflow_reference: reference, target_repo: repoPath } = args as Record<string, unknown>;
  return typeof reference === "string" && TASKFLOW_REFERENCE.test(reference) && typeof repoPath === "string" && repoPath
    ? { reference, repoPath } : null;
}

export async function recordDelegationTaskRunEnd(
  store: TaskStore | null | undefined,
  run: Pick<DelegationRunRow, "id" | "args_json" | "subsidiary_id">,
  reason: string,
  onError: (error: unknown) => void,
): Promise<void> {
  const target = runTaskTarget(run);
  if (!store?.recordRunEnd || !target) return;
  try { await store.recordRunEnd(target.repoPath, target.reference, run.id, reason, run.subsidiary_id ?? null); }
  catch (error) { onError(error); }
}
