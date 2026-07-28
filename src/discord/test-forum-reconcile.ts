import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorTestWorkflowProduct } from "../pr/revisor-test-workflow-client.js";

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
  | "candidate-unavailable"
  | "head-updated"
  | "worktree-removed";

export interface TestForumReconcileResult {
  scanned: number;
  kept: number;
  created: number;
  closed: number;
}

export function buildTestForumCandidates(
  products: readonly RevisorTestWorkflowProduct[],
): TestForumCandidate[] {
  return products.map((product) => ({
    repoOrigin: product.repository,
    prNumber: product.number,
    title: product.title,
    url: null,
    headBranch: null,
    headSha: product.reviewedHeadSha,
    worktreePath: null,
  }));
}

function prKey(origin: string, number: number): string {
  return `${origin.toLowerCase()}#${number}`;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function closeReason(
  surface: DiscordTestSurfaceRow,
  candidate: TestForumCandidate | undefined,
): TestSurfaceCloseReason | null {
  if (!candidate) return "candidate-unavailable";
  if (surface.head_sha !== candidate.headSha) return "head-updated";
  if (
    surface.worktree_path
    && (!candidate.worktreePath
      || normalizedPath(surface.worktree_path) !== normalizedPath(candidate.worktreePath))
  ) {
    return "worktree-removed";
  }
  return null;
}

export async function reconcileTestForum(input: {
  candidates: readonly TestForumCandidate[];
  surfaces: DiscordTestSurfacesRepo;
  adapter: TestForumSurfaceAdapter;
}): Promise<TestForumReconcileResult> {
  const candidatesByPr = new Map(input.candidates.map((candidate) => [
    prKey(candidate.repoOrigin, candidate.prNumber),
    candidate,
  ]));
  const existing = input.surfaces.listOpen();
  const keptKeys = new Set<string>();
  let closed = 0;

  for (const surface of existing) {
    const key = prKey(surface.repo_origin, surface.pr_number);
    const reason = closeReason(surface, candidatesByPr.get(key));
    if (!reason) {
      keptKeys.add(key);
      continue;
    }
    await input.adapter.close(surface, reason);
    input.surfaces.close(surface.id, reason);
    closed += 1;
  }

  let created = 0;
  for (const candidate of input.candidates) {
    const key = prKey(candidate.repoOrigin, candidate.prNumber);
    if (keptKeys.has(key)) continue;
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
