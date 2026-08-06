import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectCodes } from "./project-codes.js";

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

/**
 * Canonical PROJECT-CODES.md を正本に、repository path と人間の指示文を project へ解決する。
 * 裸の project code は運用ルールどおり大小文字を区別する。
 */
export function createProjectResolver(
  workspaceRoots: readonly string[],
  log: { warn: (message: string) => void },
): ProjectResolver {
  const byProject = new Map<string, string>();
  const exactCodes = new Map<string, ProjectTarget>();
  const foldedCodes = new Map<string, ProjectTarget>();
  const targets: ProjectTarget[] = [];

  try {
    const document = loadProjectCodes(workspaceRoots);
    for (const category of document.categories) {
      for (const [rawCodes, project] of category.entries) {
        const codes = rawCodes.split("/").map((code) => code.trim()).filter(Boolean);
        const canonicalCode = codes[0];
        if (!canonicalCode) continue;
        const root = workspaceRoots.find((candidate) => existsSync(resolve(candidate, project)));
        if (!root) continue;
        const target = { code: canonicalCode, project, cwd: resolve(root, project) };
        byProject.set(project.toLowerCase(), canonicalCode);
        targets.push(target);
        for (const code of codes) {
          exactCodes.set(code, target);
          foldedCodes.set(code.toLowerCase(), target);
        }
      }
    }
  } catch (error) {
    log.warn(`project codes unavailable: ${(error as Error).message}`);
  }

  const codeForRepo = (repoPath: string): string => {
    const leaf = repoPath.split(/[\\/]/).filter(Boolean).pop() || "Session";
    const normalized = normalizeWorktreeLeaf(leaf).toLowerCase();
    const exact = byProject.get(normalized);
    if (exact) return exact;
    const worktreeProject = [...byProject.entries()]
      .sort(([a], [b]) => b.length - a.length)
      .find(([project]) => normalized.startsWith(`${project}-`));
    return worktreeProject?.[1] ?? leaf;
  };

  const targetFromText = (title: string, body = ""): ProjectTarget | null => {
    const text = `${title}\n${body}`;
    const bracketCodes = text.matchAll(/\[([^\]]+)\]/g);
    for (const match of bracketCodes) {
      const code = match[1]?.trim();
      if (!code) continue;
      const target = exactCodes.get(code) ?? foldedCodes.get(code.toLowerCase());
      if (target) return target;
    }
    const codeMatch = [...exactCodes.entries()]
      .sort(([a], [b]) => b.length - a.length)
      .find(([code]) => tokenPattern(code).test(text));
    if (codeMatch) return codeMatch[1];
    const projectMatch = [...targets]
      .sort((a, b) => b.project.length - a.project.length)
      .find((target) => tokenPattern(target.project, "i").test(text));
    return projectMatch ?? null;
  };

  const codesForRepos = (repoPaths: readonly string[]): string[] => {
    const codes: string[] = [];
    for (const repoPath of repoPaths) {
      const code = codeForRepo(repoPath);
      if (!foldedCodes.has(code.toLowerCase()) || codes.includes(code)) continue;
      codes.push(code);
    }
    return codes.length > 1 ? codes.filter((code) => code !== "Ar") : codes;
  };

  return { codeForRepo, codesForRepos, targetFromText };
}

function normalizeWorktreeLeaf(leaf: string): string {
  return leaf.replace(/^(?:\.wt-|wt-|\.worktree-)/i, "");
}

function tokenPattern(value: string, flags = ""): RegExp {
  return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(value)}([^a-z0-9_]|$)`, flags);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
