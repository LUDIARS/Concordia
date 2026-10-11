/**
 * 引き継ぎの自動判定 (spec/feature/task-workflow-v3.md §引き継ぎの再利用)。
 *
 * 同じ (リポジトリ, ブランチ) で前の run が task に結びついたまま終わっていれば、
 * 新しい task を作らずその task を続ける。判定は純関数にし、run と session の読み出しは
 * 呼び出し側の adapter (db/delegation-task-runs.ts) が渡す。
 */
import { repositoryKey } from "../taskflow/actio-binding.js";
import { TASKFLOW_REFERENCE } from "./work-key.js";

export interface HandoffCandidate {
  runId: string;
  reference: string | null;
  targetRepo: string | null;
  branch: string | null;
  runStatus: string;
  sessionStatus: string | null;
  createdAt: number;
}

const TERMINAL_RUN = new Set(["completed", "failed", "spawn_failed"]);
const ENDED_SESSION = new Set(["lost", "ended"]);

/** run がもう作業していないか。終わった session か、終了状態の run。 */
export function isRunOver(candidate: Pick<HandoffCandidate, "runStatus" | "sessionStatus">): boolean {
  return TERMINAL_RUN.has(candidate.runStatus)
    || (candidate.sessionStatus !== null && ENDED_SESSION.has(candidate.sessionStatus));
}

/** 引き継ぐ task 参照。まだ作業中の run が残っている task は選ばない (同時に 1 run)。 */
export function selectHandoffReference(
  candidates: readonly HandoffCandidate[], target: { repoPath: string; branch: string | null },
): string | null {
  if (!target.branch) return null;
  const repo = repositoryKey(target.repoPath);
  const scoped = candidates.filter((item) => item.branch === target.branch && item.targetRepo !== null
    && repositoryKey(item.targetRepo) === repo && item.reference !== null && TASKFLOW_REFERENCE.test(item.reference));
  const busy = new Set(scoped.filter((item) => !isRunOver(item)).map((item) => item.reference));
  const ended = scoped.filter((item) => isRunOver(item) && !busy.has(item.reference))
    .sort((a, b) => b.createdAt - a.createdAt);
  return ended[0]?.reference ?? null;
}
