import { contract } from './ontime-runtime.js'; /* augur-inject:import:f596cea4 */
import augurContract_69922eb3 from './worktree-add-failure.contract.js'; /* augur-inject:contract-predicate:08ef8102 */
/**
 * Decide what to do after `git worktree add` exited non-zero.
 *
 * Git runs the post-checkout hook after the worktree has been fully checked
 * out, so a failing hook (e.g. a core.hooksPath hook calling a missing
 * git-lfs) makes the command exit non-zero even though the worktree and the
 * branch already exist. Judge the outcome by what git actually registered
 * instead of by the exit code; anything half-made is cleaned up.
 *
 * @implements spec/feature/delegation-spawn-target-validation.md §2.5
 */

export interface RegisteredWorktree {
  path: string;
  branch: string | null;
}

export interface WorktreeAddFailureInput {
  /** `git worktree list --porcelain` entries read after the failed add. */
  worktrees: readonly RegisteredWorktree[];
  worktreePath: string;
  branch: string;
  /** Whether the branch ref exists now. */
  branchExists: boolean;
  /** Whether the branch ref existed before the add (then it is never deleted). */
  branchExistedBefore: boolean;
  platform?: NodeJS.Platform;
}

export type WorktreeAddFailureDecision =
  | { kind: "adopt" }
  | { kind: "cleanup"; removeWorktree: boolean; deleteBranch: boolean };

export function decideWorktreeAddFailure(input: WorktreeAddFailureInput): WorktreeAddFailureDecision {
  const platform = input.platform ?? process.platform;
  const target = normalizeWorktreePath(input.worktreePath, platform);
  const registered = input.worktrees.find((entry) => normalizeWorktreePath(entry.path, platform) === target);
  if (registered && registered.branch === input.branch && input.branchExists) return { kind: "adopt" };
  return {
    kind: "cleanup",
    removeWorktree: Boolean(registered),
    deleteBranch: input.branchExists && !input.branchExistedBefore,
  };
}
// @ts-expect-error augur-inject
decideWorktreeAddFailure = contract(decideWorktreeAddFailure, { ...augurContract_69922eb3, contractId: 'wtadd-C-1', mode: 'observe', sample: 1, where: 'src/control/worktree-add-failure.ts:34', rule: 'contract-wrap', id: '69922eb3' }); /* augur-inject:contract-wrap:69922eb3 */

export function normalizeWorktreePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}
