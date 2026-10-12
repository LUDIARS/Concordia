/** @implements spec/feature/delegation-spawn-target-validation.md §2.5 — worktree add 失敗後の判定 */
interface Entry { path: string; branch: string | null }
interface Input {
  worktrees: readonly Entry[];
  worktreePath: string;
  branch: string;
  branchExists: boolean;
  branchExistedBefore: boolean;
  platform?: string;
}

export default {
  post(result: unknown, input: Input): boolean {
    if (!result || typeof result !== "object") return false;
    const decision = result as { kind?: unknown; removeWorktree?: unknown; deleteBranch?: unknown };
    const win = (input.platform ?? process.platform) === "win32";
    const norm = (p: string) => {
      const n = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
      return win ? n.toLowerCase() : n;
    };
    const registered = input.worktrees.find((entry) => norm(entry.path) === norm(input.worktreePath));
    if (registered && registered.branch === input.branch && input.branchExists) return decision.kind === "adopt";
    return decision.kind === "cleanup"
      && decision.removeWorktree === Boolean(registered)
      && decision.deleteBranch === (input.branchExists && !input.branchExistedBefore);
  },
};
