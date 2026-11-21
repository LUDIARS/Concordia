import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import { isMergeCommit, mergeObservationKey } from "./merge-return-policy.js";
import type { MergeReturnRepository } from "./merge-return-repository.js";
import type { MergeReturnService } from "./merge-return-service.js";

type MergeFact = Pick<RevisorLocalPr, "id" | "status" | "repository" | "mergeCommitSha"> &
  Partial<Pick<RevisorLocalPr, "baseRef" | "updatedAt">>;
type Project = Pick<ProjectCodeRow, "code" | "repo_origin">;

export function createMergeObserver(deps: {
  enabledAt: ReadonlyMap<string, number>;
  repository: Pick<MergeReturnRepository, "find">;
  service: Pick<MergeReturnService, "observe">;
  projects: { list(): Project[]; findByRepoOrigin(origin: string): Project | null };
  pullRequest: (id: string) => Promise<RevisorLocalPr | null>;
  listMerges: (since: number) => Promise<RevisorLocalPr[]>;
  report: (message: string) => void;
}) {
  const enabledFrom = Math.min(...deps.enabledAt.values());
  const isOld = (pr: MergeFact, project: string) => {
    const since = deps.enabledAt.get(project);
    return since !== undefined && !(Date.parse(pr.updatedAt ?? "") >= since);
  };

  function recordObservedMerge(pr: MergeFact): boolean {
    const project = deps.projects.findByRepoOrigin(pr.repository);
    if (!project) return true;
    if (isOld(pr, project.code)) return true;
    if (pr.status !== "merged" || !isMergeCommit(pr.mergeCommitSha) || !pr.baseRef) return false;
    const key = mergeObservationKey(project.code, pr.id, pr.mergeCommitSha);
    const status = deps.service.observe(key, {
      project_code: project.code, merge_commit_sha: pr.mergeCommitSha, branch: pr.baseRef,
    });
    if (status) {
      const reason = status === "breaker_open" ? deps.repository.find(key)?.reason : null;
      deps.report(`Revisor merge return observed: ${project.code} ${status}${reason ? ` (${reason})` : ""}`);
    }
    return true;
  }

  return {
    observe: recordObservedMerge,
    discover: enabledFrom === Infinity ? undefined : async (signal: AbortSignal) => {
      const projects = new Map(deps.projects.list().filter((project) => project.repo_origin && deps.enabledAt.has(project.code))
        .map((project) => [normalizeRepoOrigin(project.repo_origin ?? "").toLowerCase(), project]));
      for (const summary of await deps.listMerges(enabledFrom)) {
        if (signal.aborted) return;
        const project = projects.get(summary.repository.toLowerCase());
        if (!project || isOld(summary, project.code) || !isMergeCommit(summary.mergeCommitSha)) continue;
        if (deps.repository.find(mergeObservationKey(project.code, summary.id, summary.mergeCommitSha))) continue;
        try {
          const pr = await deps.pullRequest(summary.id);
          if (signal.aborted) return;
          if (!pr || pr.id !== summary.id || pr.mergeCommitSha !== summary.mergeCommitSha
            || pr.repository.toLowerCase() !== summary.repository.toLowerCase() || !recordObservedMerge(pr)) {
            deps.report(`Revisor merge return could not confirm PR ${summary.id}`);
          }
        } catch {
          deps.report(`Revisor merge return could not process PR ${summary.id}`);
        }
      }
    },
  };
}
