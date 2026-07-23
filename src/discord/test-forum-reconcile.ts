import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { PrRecordRow } from "../db/pr-records-repo.js";
import type { RepoStatus } from "../work/repo-scan.js";

export interface TestForumCandidate {
  repoOrigin: string;
  prNumber: number;
  title: string;
  url: string | null;
  headBranch: string | null;
  headSha: string;
  worktreePath: string | null;
}

export interface TestForumSurfaceAdapter {
  create(candidate: TestForumCandidate): Promise<{ threadId: string }>;
  close(surface: DiscordTestSurfaceRow, reason: TestSurfaceCloseReason): Promise<void>;
}

export type TestSurfaceCloseReason =
  | "pr-merged"
  | "pr-closed"
  | "pr-unavailable"
  | "head-updated"
  | "worktree-removed";

export interface TestForumReconcileResult {
  scanned: number;
  kept: number;
  created: number;
  closed: number;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function repoName(origin: string): string {
  return origin.replace(/\\/g, "/").replace(/\.git$/i, "").split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
}

function matchingRepo(pr: PrRecordRow, repos: readonly RepoStatus[]): RepoStatus | null {
  const exactPath = pr.repo_path ? normalizedPath(pr.repo_path) : null;
  return repos.find((repo) => exactPath === normalizedPath(repo.path))
    ?? repos.find((repo) => repo.name.toLowerCase() === repoName(pr.repo_origin))
    ?? null;
}

export function buildTestForumCandidates(
  prs: readonly PrRecordRow[],
  repos: readonly RepoStatus[],
): TestForumCandidate[] {
  return prs.flatMap((pr): TestForumCandidate[] => {
    const headSha = pr.head_sha?.trim();
    if ((pr.state !== "open" && pr.state !== "draft") || !headSha) return [];
    const repo = matchingRepo(pr, repos);
    const worktree = pr.head_branch && repo
      ? repo.worktrees.find((entry) => entry.branch === pr.head_branch)
      : null;
    return [{
      repoOrigin: pr.repo_origin,
      prNumber: pr.number,
      title: pr.title,
      url: pr.url,
      headBranch: pr.head_branch,
      headSha,
      worktreePath: worktree?.path ?? null,
    }];
  });
}

function prKey(origin: string, number: number): string {
  return `${origin.toLowerCase()}#${number}`;
}

function worktreeStillPresent(surface: DiscordTestSurfaceRow, candidate: TestForumCandidate): boolean {
  if (!surface.worktree_path) return true;
  return !!candidate.worktreePath
    && normalizedPath(candidate.worktreePath) === normalizedPath(surface.worktree_path);
}

function closeReason(
  surface: DiscordTestSurfaceRow,
  pr: PrRecordRow | undefined,
  candidate: TestForumCandidate | undefined,
): TestSurfaceCloseReason | null {
  if (!pr) return "pr-unavailable";
  if (pr.state === "merged") return "pr-merged";
  if (pr.state === "closed") return "pr-closed";
  if (!candidate || surface.head_sha !== candidate.headSha) return "head-updated";
  if (!worktreeStillPresent(surface, candidate)) return "worktree-removed";
  return null;
}

export async function reconcileTestForum(input: {
  prs: readonly PrRecordRow[];
  repos: readonly RepoStatus[];
  surfaces: DiscordTestSurfacesRepo;
  adapter: TestForumSurfaceAdapter;
}): Promise<TestForumReconcileResult> {
  const candidates = buildTestForumCandidates(input.prs, input.repos);
  const candidatesByPr = new Map(candidates.map((candidate) => [
    prKey(candidate.repoOrigin, candidate.prNumber),
    candidate,
  ]));
  const prsByKey = new Map(input.prs.map((pr) => [prKey(pr.repo_origin, pr.number), pr]));
  const existing = input.surfaces.listOpen();
  const keptKeys = new Set<string>();
  const worktreeRemovedKeys = new Set<string>();
  let closed = 0;

  for (const surface of existing) {
    const key = prKey(surface.repo_origin, surface.pr_number);
    const reason = closeReason(surface, prsByKey.get(key), candidatesByPr.get(key));
    if (!reason) {
      keptKeys.add(key);
      continue;
    }
    await input.adapter.close(surface, reason);
    input.surfaces.close(surface.id, reason);
    closed += 1;
    if (reason === "worktree-removed") worktreeRemovedKeys.add(key);
  }

  let created = 0;
  for (const candidate of candidates) {
    const key = prKey(candidate.repoOrigin, candidate.prNumber);
    if (keptKeys.has(key) || worktreeRemovedKeys.has(key)) continue;
    const createdSurface = await input.adapter.create(candidate);
    input.surfaces.create({
      repoOrigin: candidate.repoOrigin,
      prNumber: candidate.prNumber,
      headSha: candidate.headSha,
      worktreePath: candidate.worktreePath,
      threadId: createdSurface.threadId,
    });
    created += 1;
  }

  return { scanned: existing.length, kept: keptKeys.size, created, closed };
}
