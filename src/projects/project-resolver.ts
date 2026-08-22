import type { ProjectCodeRow } from "../db/project-codes-repo.js";

export interface ProjectTarget {
  code: string;
  project: string;
  cwd: string;
}

export interface ProjectResolver {
  codeForRepo: (repoPath: string) => string;
  codesForRepos: (repoPaths: readonly string[]) => string[];
  targetFromText: (title: string, body?: string) => ProjectTarget | null;
}

/** workspace root (Castra) の project code。 単独でない限りタイトルから落とす。 */
const WORKSPACE_ROOT_CODE = "Ar";

/** Cc DB の現在値から resolver を作る。code は大文字小文字を区別する。 */
export function createProjectResolver(rows: readonly ProjectCodeRow[]): ProjectResolver {
  const exactCodes = new Map<string, ProjectTarget>();
  const targets = rows.map((row) => ({ code: row.code, project: row.project, cwd: row.repo_path }));
  for (const target of targets) exactCodes.set(target.code, target);

  const targetForRepo = (repoPath: string): ProjectTarget | null => {
    const normalizedPath = normalizePath(repoPath);
    const exact = rows.find((row) => normalizePath(row.repo_path) === normalizedPath);
    if (exact) return { code: exact.code, project: exact.project, cwd: exact.repo_path };

    const leaf = normalizeWorktreeLeaf(repoLeaf(repoPath)).toLowerCase();
    const worktree = rows
      .slice()
      .sort((a, b) => b.project.length - a.project.length)
      .find((row) => leaf === row.project.toLowerCase() || leaf.startsWith(`${row.project.toLowerCase()}-`));
    return worktree ? { code: worktree.code, project: worktree.project, cwd: worktree.repo_path } : null;
  };

  const codeForRepo = (repoPath: string): string => {
    return targetForRepo(repoPath)?.code ?? (repoLeaf(repoPath) || "Session");
  };

  const targetFromText = (title: string, body = ""): ProjectTarget | null => {
    const text = `${title}\n${body}`;
    for (const match of text.matchAll(/\[([^\]]+)]/g)) {
      const code = match[1]?.trim();
      if (code && exactCodes.has(code)) return exactCodes.get(code)!;
    }
    const codeMatch = [...exactCodes.entries()]
      .sort(([a], [b]) => b.length - a.length)
      .find(([code]) => tokenPattern(code).test(text));
    if (codeMatch) return codeMatch[1];
    return targets
      .slice()
      .sort((a, b) => b.project.length - a.project.length)
      .find((target) => tokenPattern(target.project, "i").test(text)) ?? null;
  };

  const codesForRepos = (repoPaths: readonly string[]): string[] => {
    const codes: string[] = [];
    for (const repoPath of repoPaths) {
      const code = targetForRepo(repoPath)?.code;
      if (code && !codes.includes(code)) codes.push(code);
    }
    // workspace root (Ar / Castra) は「wrap した場所」であって作業対象ではない。
    // 他に 1 つでもコードがあれば落とす (spec/feature/session-surface-project-codes.md 2.2)。
    // root 単独のときだけ残し、 タイトルが空になるのを避ける。
    return codes.length > 1 ? codes.filter((code) => code !== WORKSPACE_ROOT_CODE) : codes;
  };

  return { codeForRepo, codesForRepos, targetFromText };
}

function repoLeaf(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

function normalizeWorktreeLeaf(leaf: string): string {
  return leaf.replace(/^(?:\.wt-|wt-|\.worktree-)/i, "");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function tokenPattern(value: string, flags = ""): RegExp {
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(value)}([^a-z0-9_]|$)`, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
