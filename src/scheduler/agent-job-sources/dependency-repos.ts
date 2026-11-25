/**
 * 依存点検の対象: service-map のリポのうち、 origin が設定の GitHub org にあるものの
 * マニフェストの所在 (GitHub の URL) と、 main の package.json の依存宣言 (名前と版指定)。
 * 外部エージェントは URL を読みに行けないため、 依存宣言は Cc が読んで渡す。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter (依存点検)
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { DependencyRepo } from "../agent-jobs/deps-sweep-daily.js";
import { readDependencyDeclarations } from "./dependency-declarations.js";
import type { GitRead } from "./git-read.js";
import type { ServiceMapRepo } from "./service-map.js";

/** リポ root からの相対パスで探すマニフェスト。 */
export const MANIFEST_CANDIDATES = [
  "package.json", "web/package.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
  "vcpkg.json", "conanfile.txt", "Packages/manifest.json",
] as const;

/**
 * 純関数: origin の URL を `https://github.com/<owner>/<repo>` に正規化する。 github.com 以外・資格情報付きは null。
 */
export function normalizeGithubOrigin(origin: string): { owner: string; repo: string; url: string } | null {
  const trimmed = origin.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/u.exec(trimmed);
  if (!match) return null;
  const [, owner, repo] = match as unknown as [string, string, string];
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function readDependencyRepos(deps: {
  workspaceRoot: string; repos: ServiceMapRepo[]; githubOrg: string; git: GitRead;
}): Promise<DependencyRepo[]> {
  const org = deps.githubOrg.trim().toLowerCase();
  if (!org) throw new Error("github org is not configured; cannot tell public repositories");
  const result: DependencyRepo[] = [];
  for (const repo of deps.repos) {
    const repoPath = join(deps.workspaceRoot, repo.name);
    const origin = await deps.git(repoPath, ["remote", "get-url", "origin"]);
    const github = origin ? normalizeGithubOrigin(origin) : null;
    if (!github || github.owner.toLowerCase() !== org) continue;
    const found: string[] = [];
    for (const candidate of MANIFEST_CANDIDATES) {
      if (await exists(join(repoPath, ...candidate.split("/")))) found.push(candidate);
    }
    const manifests = found.map((candidate) => `${github.url}/blob/main/${candidate}`);
    const declarations = await readDependencyDeclarations(deps.git, repoPath, found);
    result.push({ name: repo.name, code: repo.code, url: github.url, manifests, declarations });
  }
  return result;
}
