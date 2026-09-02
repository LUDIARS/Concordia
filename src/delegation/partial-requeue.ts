import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { DelegationService } from "./service.js";
import { inheritDelegationRuntime } from "./continuation-runtime.js";

/** @implements spec/feature/deterministic-teardown.md §4 */

export interface RemainingWork {
  title: string;
  note?: string;
  scope_dirs?: string[];
}

const PARTIAL_REQUEUE_PREFIX = "partial-requeue:";
export const MAX_PARTIAL_REQUEUE_DEPTH = 32;

type PartialRequeueRunRepository = Pick<
  { findRun(id: string): DelegationRunRow | null },
  "findRun"
>;

function partialRequeueParentId(run: DelegationRunRow): string | null {
  const triggeredBy = run.triggered_by;
  if (!triggeredBy?.startsWith(PARTIAL_REQUEUE_PREFIX)) return null;
  const parentId = triggeredBy.slice(PARTIAL_REQUEUE_PREFIX.length);
  return parentId || null;
}

/** Returns the number of partial-requeue hops that led to this run. */
export function requeueDepth(run: DelegationRunRow, repo: PartialRequeueRunRepository): number {
  let depth = 0;
  let current: DelegationRunRow | null = run;
  while (depth < MAX_PARTIAL_REQUEUE_DEPTH) {
    const parentId = partialRequeueParentId(current);
    if (!parentId) return depth;
    depth += 1;
    current = repo.findRun(parentId);
    if (!current) return depth;
  }
  return MAX_PARTIAL_REQUEUE_DEPTH;
}

/** Returns the first run in a partial-requeue chain, or the supplied run itself. */
export function rootRunId(run: DelegationRunRow, repo: PartialRequeueRunRepository): string {
  let rootId = run.id;
  let current: DelegationRunRow | null = run;
  for (let traversed = 0; traversed < MAX_PARTIAL_REQUEUE_DEPTH; traversed += 1) {
    const parentId = partialRequeueParentId(current);
    if (!parentId) return rootId;
    rootId = parentId;
    current = repo.findRun(parentId);
    if (!current) return rootId;
  }
  return rootId;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export async function requeuePartialRun(input: {
  run: DelegationRunRow;
  remaining: readonly RemainingWork[];
  service: DelegationService;
}): Promise<Awaited<ReturnType<DelegationService["invoke"]>>> {
  const remainingText = input.remaining.map((item, index) => [
    `${index + 1}. ${item.title}`,
    item.note?.trim() ? `   note: ${item.note.trim()}` : "",
    item.scope_dirs?.length ? `   scope_dirs: ${item.scope_dirs.join(", ")}` : "",
  ].filter(Boolean).join("\n")).join("\n");
  const cwd = input.run.spawn_worktree_path ?? input.run.spawn_cwd ?? undefined;
  return input.service.invoke({
    call_name: input.run.call_name,
    args: parseArgs(input.run.args_json),
    cwd,
    branch: input.run.spawn_branch ?? undefined,
    // 既存 worktree を引き継ぐ。新規 worktree を同じ branch に作ろうとしない。
    worktree: false,
    parent_session_id: input.run.parent_session_id,
    triggered_by: `partial-requeue:${input.run.id}`,
    ...inheritDelegationRuntime(input.run),
    extra_prompt: [
      `前 run ${input.run.id} の残作業を引き継いだワンショット実行です。`,
      "以下を完了し、完了後は status API で報告してください。",
      remainingText,
    ].join("\n\n"),
  });
}
