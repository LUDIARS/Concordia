// 作業成果の commit / submit の手順 (use case)。 判定は submission-route.ts と
// delegation/commit-guard.ts、 git は commit-worktree.ts が持つ。
// 規則の説明は spec/feature/work-submission.md。

import { resolve, sep } from "node:path";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { commitWorktree, type CommitWorktreeOutcome } from "./commit-worktree.js";
import { resolveSubmissionRoute, type SubmissionRoute } from "./submission-route.js";

export interface WorkSubmissionDeps {
  projectCodes: Pick<ProjectCodesRepo, "list">;
  resolveWorkspaceRoots: () => string[];
  /** main へ直接コミットする例外リポジトリ。 既定は env CONCORDIA_DIRECT_MAIN_REPOS */
  directMainRepos?: () => string[];
}

export interface WorkSession {
  id: string;
  repo_path?: string | null;
  branch?: string | null;
}

function normalize(path: string): string {
  const resolved = resolve(path);
  const trimmed = resolved.endsWith(sep) && resolved.length > 1 ? resolved.slice(0, -sep.length) : resolved;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function envDirectMainRepos(): string[] {
  const configured = process.env.CONCORDIA_DIRECT_MAIN_REPOS;
  return configured ? configured.split(";").map((path) => path.trim()).filter(Boolean) : [];
}

export class WorkSubmissionService {
  constructor(private readonly deps: WorkSubmissionDeps) {}

  /** リポジトリの経路を解く。 フック・セッションの両方がこの結果だけを見る。 */
  routeForRepo(repoPath: string): SubmissionRoute & { project_code: string | null } {
    // 登録直後から効かせるため snapshot を持たず、 都度 DB を読む。
    const rows = this.deps.projectCodes.list();
    const target = normalize(repoPath);
    const row = rows.find((candidate) => candidate.repo_path && normalize(candidate.repo_path) === target);
    const route = resolveSubmissionRoute({
      repoPath,
      workflow: row?.revisor_workflow ?? null,
      registered: row !== undefined,
      workspaceRoots: this.deps.resolveWorkspaceRoots(),
      directMainRepos: (this.deps.directMainRepos ?? envDirectMainRepos)(),
    });
    return { ...route, project_code: row?.code ?? null };
  }

  /**
   * セッションの作業範囲をコミットする。 委託 run と同じ guard を通すので、
   * 保護ブランチ・リポジトリ外・変更過多はここで止まる。
   */
  async commit(session: WorkSession, input: { message: string; paths?: readonly string[] }): Promise<CommitWorktreeOutcome> {
    if (!session.repo_path) {
      return { ok: false, code: "run_cwd_unknown", detail: "session has no repo_path; bind the session first" };
    }
    const message = input.message.trim();
    if (!message) return { ok: false, code: "invalid_request", detail: "message is required" };
    return await commitWorktree({
      cwd: session.repo_path,
      branch: session.branch ?? null,
      message,
      ...(input.paths && input.paths.length > 0 ? { paths: input.paths } : {}),
      trailers: [`Cc-Session: ${session.id}`],
    });
  }
}
