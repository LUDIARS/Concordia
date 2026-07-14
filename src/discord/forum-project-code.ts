import { loadProjectCodes } from "../projects/project-codes.js";

/** Canonical PROJECT-CODES.md を一度だけ読み、repo path から forum title 用コードを返す。 */
export function createForumProjectCodeResolver(
  workspaceRoots: readonly string[],
  log: { warn: (message: string) => void },
): (repoPath: string) => string {
  const byProject = new Map<string, string>();
  try {
    const document = loadProjectCodes(workspaceRoots);
    for (const category of document.categories) {
      for (const [rawCode, project] of category.entries) {
        const code = rawCode.split("/")[0]?.trim();
        if (code) byProject.set(project.toLowerCase(), code);
      }
    }
  } catch (error) {
    // Concordia can run outside the Ars monorepo. Keep the forum usable and make
    // the degraded title (repo leaf instead of canonical code) observable.
    log.warn(`forum project codes unavailable: ${(error as Error).message}`);
  }

  return (repoPath: string): string => {
    const leaf = repoPath.split(/[\\/]/).filter(Boolean).pop() || "Session";
    const normalized = leaf.toLowerCase();
    const exact = byProject.get(normalized);
    if (exact) return exact;
    // Task worktrees conventionally use `<Project>-<task>`. Resolve those to the
    // canonical project code while keeping unrelated directory names untouched.
    const worktreeProject = [...byProject.entries()]
      .sort(([a], [b]) => b.length - a.length)
      .find(([project]) => normalized.startsWith(`${project}-`));
    return worktreeProject?.[1] ?? leaf;
  };
}
