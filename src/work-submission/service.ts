// 作業成果の commit / submit の手順 (use case)。 判定は submission-route.ts と
// delegation/commit-guard.ts、 git は commit-worktree.ts が持つ。
// 規則の説明は spec/feature/work-submission.md。

import { resolve, sep } from "node:path";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { commitWorktree, type CommitWorktreeOutcome } from "./commit-worktree.js";
import { mainCheckoutPath } from "./main-checkout.js";
import { submitGithubPr, type GithubPrSubmitDeps, type GithubPrSubmitResult } from "./github-pr-submit.js";
import { readGithubPrContent } from "./github-pr-content.js";
import { resolveSubmissionRoute, type SubmissionRoute } from "./submission-route.js";
import { mainPushRouteWarning } from "./route-consistency.js";
import { isMainPushAllowlisted } from "../harness/main-push-allowlist.js";

export interface WorkSubmissionDeps {
  projectCodes: Pick<ProjectCodesRepo, "list">;
  resolveWorkspaceRoots: () => string[];
  /** main へ直接コミットする例外リポジトリ。 既定は env CONCORDIA_DIRECT_MAIN_REPOS */
  directMainRepos?: () => string[];
  /** linked worktree から本体 checkout を解く。 既定は Git メタデータを読む {@link mainCheckoutPath} */
  mainCheckout?: (repoPath: string) => string | Promise<string>;
  /** GitHub Workflow の提出 (push と PR 作成)。 未配線なら github-pr は手順を返すだけ。 */
  githubPr?: GithubPrSubmitDeps;
  /** PR の題と本文をブランチのコミットから読む。 既定は {@link readGithubPrContent} */
  readPrContent?: (repoPath: string, base: string) => Promise<{ title: string; body: string } | null>;
  /** ハーネスの main 直 push 許可リスト。 経路との食い違いを警告するためだけに読む。 */
  mainPushAllowlist?: () => string[];
}

export interface WorkSession {
  id: string;
  repo_path?: string | null;
  repo_origin?: string | null;
  branch?: string | null;
}

export type GithubPrSubmission =
  | GithubPrSubmitResult
  | { submitted: false; reason: "github_pr_unavailable" | "session_unbound" | "no_commits"; next_action: string };

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
  async routeForRepo(repoPath: string): Promise<SubmissionRoute & { project_code: string | null; consistency_warning?: string }> {
    // 登録直後から効かせるため snapshot を持たず、 都度 DB を読む。
    const rows = this.deps.projectCodes.list();
    // 登録は本体 checkout の repo_path。 worktree からの照会も本体で照合する。
    const main = await (this.deps.mainCheckout ?? mainCheckoutPath)(repoPath);
    const target = normalize(main);
    const row = rows.find((candidate) => candidate.repo_path && normalize(candidate.repo_path) === target);
    const route = resolveSubmissionRoute({
      repoPath: main,
      workflow: row?.revisor_workflow ?? null,
      registered: row !== undefined,
      workspaceRoots: this.deps.resolveWorkspaceRoots(),
      directMainRepos: (this.deps.directMainRepos ?? envDirectMainRepos)(),
    });
    const warning = mainPushRouteWarning({
      route: route.route,
      mainPushAllowlisted: isMainPushAllowlisted({ cwd: main }, this.deps.mainPushAllowlist?.() ?? []),
    });
    return { ...route, project_code: row?.code ?? null, ...(warning ? { consistency_warning: warning } : {}) };
  }

  /**
   * GitHub Workflow の提出。 経路が github-pr と決まった後に呼ぶ (経路判定はここでは繰り返さない)。
   * ブランチのコミットから題と本文を作り、push → 既存 PR 照合 → 作成の順で進める。
   */
  async submitGithubPr(session: WorkSession): Promise<GithubPrSubmission> {
    const github = this.deps.githubPr;
    if (!github) {
      return { submitted: false, reason: "github_pr_unavailable", next_action: "Cc に GitHub 提出が配線されていない。revisor push と gh pr create を手で行う。" };
    }
    if (!session.repo_path) {
      return { submitted: false, reason: "session_unbound", next_action: "session has no repo_path; bind the session first" };
    }
    const content = await (this.deps.readPrContent ?? readGithubPrContent)(session.repo_path, github.baseBranch());
    if (!content) {
      return { submitted: false, reason: "no_commits", next_action: "base から進んだコミットが無い。コミットしてから提出する。" };
    }
    return await submitGithubPr(github, {
      sessionId: session.id,
      repoPath: session.repo_path,
      repoOrigin: session.repo_origin,
      branch: session.branch,
      ...content,
    });
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
