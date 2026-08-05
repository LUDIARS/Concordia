import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectCodes } from "../projects/project-codes.js";

export interface ForumProjectTarget {
  code: string;
  project: string;
  cwd: string;
}

export interface ForumProjectResolver {
  codeForRepo: (repoPath: string) => string;
  codesForRepos: (repoPaths: string[]) => string[];
  targetFromPost: (title: string, body: string) => ForumProjectTarget | null;
}

/** Canonical PROJECT-CODES.md を一度だけ読み、repo path から forum title 用コードを返す。 */
export function createForumProjectCodeResolver(
  workspaceRoots: readonly string[],
  log: { warn: (message: string) => void },
): (repoPath: string) => string {
  return createForumProjectResolver(workspaceRoots, log).codeForRepo;
}

export function createForumProjectResolver(
  workspaceRoots: readonly string[],
  log: { warn: (message: string) => void },
): ForumProjectResolver {
  const byProject = new Map<string, string>();
  const byCode = new Map<string, ForumProjectTarget>();
  try {
    const document = loadProjectCodes(workspaceRoots);
    for (const category of document.categories) {
      for (const [rawCode, project] of category.entries) {
        const code = rawCode.split("/")[0]?.trim();
        if (!code) continue;
        byProject.set(project.toLowerCase(), code);
        const root = workspaceRoots.find((candidate) => existsSync(resolve(candidate, project)));
        if (root) byCode.set(code.toLowerCase(), { code, project, cwd: resolve(root, project) });
      }
    }
  } catch (error) {
    // Concordia can run outside the Ars monorepo. Keep the forum usable and make
    // the degraded title (repo leaf instead of canonical code) observable.
    log.warn(`forum project codes unavailable: ${(error as Error).message}`);
  }

  const codeForRepo = (repoPath: string): string => {
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

  const targetFromPost = (title: string, body: string): ForumProjectTarget | null => {
    const titleCode = /^\s*\[([^\]]+)\]/.exec(title)?.[1]?.trim().toLowerCase();
    if (titleCode && byCode.has(titleCode)) return byCode.get(titleCode)!;
    const bodyCodes = body.matchAll(/\[([^\]]+)\]/g);
    for (const match of bodyCodes) {
      const code = match[1]?.trim().toLowerCase();
      if (code && byCode.has(code)) return byCode.get(code)!;
    }
    const haystack = `${title}\n${body}`.toLowerCase();
    const projectMatch = [...byCode.values()]
      .sort((a, b) => b.project.length - a.project.length)
      .find((target) => new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(target.project.toLowerCase())}([^a-z0-9_-]|$)`).test(haystack));
    return projectMatch ?? null;
  };

  const codesForRepos = (repoPaths: string[]): string[] => {
    const codes: string[] = [];
    for (const repoPath of repoPaths) {
      const code = codeForRepo(repoPath);
      if (!byCode.has(code.toLowerCase()) || codes.includes(code)) continue;
      codes.push(code);
    }
    return codes.length > 1 ? codes.filter((code) => code !== "Ar") : codes;
  };
  return { codeForRepo, codesForRepos, targetFromPost };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
