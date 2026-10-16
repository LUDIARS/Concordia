// @spec 最後に登録した作業プロジェクト
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { isWorkspaceRootCwd } from "./session-work-policy.js";
import { configuredWorktreeRoot } from "./worktree-base-dir.js";

const pathKey = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
/** Directory names a worktree is created under inside its repository (e.g. `Concordia/.wt-x`, `Concordia/.claude/worktrees/x`). */
const NESTED_WORKTREE_SEGMENT = /^(?:\.wt-|wt-|\.worktree-|\.worktrees$|\.claude$)/i;

/**
 * The repository the session actually works in decides the project; an explicit target only fills in
 * when the checkout is not a registered repository (or its worktree), e.g. the Castra workspace root.
 * An unknown target must not select the startup repository.
 */
export function selectStartupPolicyProject(
  rows: readonly ProjectCodeRow[],
  session: { target_project?: string | null; repo_path: string; repo_origin: string | null },
  workspaceRoots: readonly string[] = [],
): ProjectCodeRow | null {
  const atWorkspaceRoot = isWorkspaceRootCwd(session.repo_path, workspaceRoots);
  const byRepo = atWorkspaceRoot ? null : projectForRepoPath(rows, session.repo_path);
  // A sibling .wt-* directory under Castra is not evidence that it belongs to
  // Castra. Prefer the checkout origin / explicit binding over that broad guess.
  const inferredWorkspace = byRepo && isWorkspaceRootCwd(byRepo.repo_path, workspaceRoots)
    && pathKey(byRepo.repo_path) !== pathKey(session.repo_path);
  if (byRepo && !inferredWorkspace) return byRepo;
  const origin = normalizeRepoOrigin(session.repo_origin ?? "").toLowerCase();
  const byOrigin = origin ? rows.find((row) => normalizeRepoOrigin(row.repo_origin ?? "").toLowerCase() === origin) : null;
  if (inferredWorkspace && byOrigin) return byOrigin;
  const target = session.target_project?.trim();
  if (target) {
    return rows.find((row) => row.code === target)
      ?? rows.find((row) => pathKey(row.repo_path) === pathKey(target))
      ?? rows.find((row) => row.project.toLowerCase() === target.toLowerCase())
      ?? null;
  }
  return byOrigin
    ?? rows.find((row) => pathKey(row.repo_path) === pathKey(session.repo_path))
    ?? null;
}

/**
 * Registered repository whose checkout or worktree is `repoPath`: exact path, nested worktree, then
 * `<repo>.wt-*` / `<repo>-*` beside the checkout or directly under `CONCORDIA_WORKTREE_ROOT`.
 */
export function projectForRepoPath(
  rows: readonly ProjectCodeRow[],
  repoPath: string,
  worktreeRoot: string | null = configuredWorktreeRoot(),
): ProjectCodeRow | null {
  const path = pathKey(repoPath);
  if (!path) return null;
  const exact = rows.find((row) => pathKey(row.repo_path) === path);
  if (exact) return exact;
  const byLongestRoot = rows.slice().sort((a, b) => pathKey(b.repo_path).length - pathKey(a.repo_path).length);
  const nested = byLongestRoot.find((row) => {
    const root = pathKey(row.repo_path);
    if (!root || !path.startsWith(`${root}/`)) return false;
    return NESTED_WORKTREE_SEGMENT.test(path.slice(root.length + 1).split("/")[0] ?? "");
  });
  if (nested) return nested;
  const parent = path.slice(0, path.lastIndexOf("/"));
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  const sharedRoot = worktreeRoot ? pathKey(worktreeRoot) : null;
  return byLongestRoot.find((row) => {
    const root = pathKey(row.repo_path);
    const rootLeaf = root.slice(root.lastIndexOf("/") + 1);
    const besideOrShared = root.slice(0, root.lastIndexOf("/")) === parent || parent === sharedRoot;
    return !!rootLeaf && besideOrShared
      && (leaf.startsWith(`${rootLeaf}.`) || leaf.startsWith(`${rootLeaf}-`));
  }) ?? null;
}
