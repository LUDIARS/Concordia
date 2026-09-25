import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { ExcubitorClient, ServiceAction } from "../excubitor/client.js";
import type { LocalPrSubmissionResult } from "../pr/local-pr-submission.js";
import { createProjectResolver } from "../projects/project-resolver.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";
import { inspectImplementationRepo, isWithinWorkspace } from "./repo-context.js";
import type { WorkSubmissionService } from "../work-submission/service.js";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { createImplementationWorktree, type CreateWorktreeInput } from "./worktree.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import {
  EXPLICIT_WORKING_BRANCH_METADATA_KEY,
  isWorkspaceRootCwd,
  WORKSPACE_ROOT_METADATA_KEY,
} from "../control/session-work-policy.js";

const nowSec = (): number => Math.floor(Date.now() / 1000);

export interface ImplementationToolsDeps {
  sessions: SessionsRepo;
  claims: TestingClaimsRepo;
  excubitor: Pick<ExcubitorClient, "control">;
  submitLocalPr: (sessionId: string, options?: { fastLane?: boolean }) => Promise<LocalPrSubmissionResult | {
    submitted: false;
    reason: "session_not_found";
  }>;
  projectCodes: ProjectCodesRepo;
  /** 作業成果の commit / 経路判定。 提出の分岐はここ 1 箇所が正本 (spec/feature/work-submission.md) */
  work: WorkSubmissionService;
  resolveWorkspaceRoots: () => string[];
  resolveActioBinding?: (repo: string, subsidiaryId: string | null) => Promise<ActioBinding>;
}

/** Stateless fast paths over existing Cc / Ex / Revisor state owners. */
export class ImplementationToolsService {
  constructor(private readonly deps: ImplementationToolsDeps) {}

  async createWorktree(input: CreateWorktreeInput) {
    const session = this.requireSession(input.sessionId);
    if (!this.deps.resolveActioBinding) throw new Error("Actio project resolver is unavailable");
    return createImplementationWorktree(input, {
      projects: this.deps.projectCodes.list(), workspaceRoots: this.deps.resolveWorkspaceRoots(),
      subsidiaryId: readSubsidiaryId(session.metadata), resolveActio: this.deps.resolveActioBinding,
      bind: value => this.bind(value),
    });
  }

  async bind(input: { sessionId: string; cwd: string; task: string }) {
    const session = this.requireSession(input.sessionId);
    const task = input.task.trim();
    if (!task) throw new Error("task is required");
    const workspaceRoots = this.deps.resolveWorkspaceRoots();
    if (!await isWithinWorkspace(input.cwd, workspaceRoots)) {
      throw new Error("cwd must be within a configured workspace root");
    }
    const context = await inspectImplementationRepo(input.cwd);
    if (!await isWithinWorkspace(context.repoPath, workspaceRoots)) {
      throw new Error("repository root must be within a configured workspace root");
    }
    // 登録コマンドの直後から効かせるため、snapshot を cache せず bind ごとに DB を読む。
    const resolver = createProjectResolver(this.deps.projectCodes.list());
    const projectCode = resolver.codeForRepo(await mainRepositoryKey(context.repoPath));
    const project = resolver.targetFromText(`[${projectCode}]`);
    if (!project) throw new Error(`project code could not be resolved for ${context.repoPath}`);
    const claimedTask = task.startsWith(`[${projectCode}]`) ? task : `[${projectCode}] ${task}`;
    const activeRepos = mergeActiveRepos(session.active_repos, context.repoPath);
    this.deps.sessions.patchSession(session.id, {
      current_task: claimedTask,
      branch: context.branch,
      repo_path: context.repoPath,
      repo_origin: context.repoOrigin,
      target_project: project.cwd,
      active_repos: activeRepos,
    });
    this.deps.sessions.mergeMetadata(session.id, {
      [EXPLICIT_WORKING_BRANCH_METADATA_KEY]: context.branch,
      ...(isWorkspaceRootCwd(session.repo_path, workspaceRoots)
        ? { [WORKSPACE_ROOT_METADATA_KEY]: session.repo_path }
        : {}),
    });
    this.deps.sessions.appendEvent({
      session_id: session.id,
      ts: nowSec(),
      kind: "implementation.tool.bind",
      payload: { project_code: projectCode, task: claimedTask, branch: context.branch },
    });
    return { ok: true, project_code: projectCode, task: claimedTask, branch: context.branch };
  }

  async controlService(input: {
    sessionId: string;
    serviceCode: string;
    action: ServiceAction;
    note?: string;
  }) {
    const session = this.requireSession(input.sessionId);
    const serviceCode = input.serviceCode.trim();
    if (!serviceCode) throw new Error("service_code is required");
    const opened = openTestingClaim(this.deps.claims, {
      service: serviceCode,
      sessionId: session.id,
      branch: session.branch,
      note: input.note?.trim() || `${input.action} via implementation tool`,
      now: nowSec(),
    });
    if (opened.conflicts.length > 0) {
      releaseTestingClaims(this.deps.claims, { sessionId: session.id, service: serviceCode, now: nowSec() });
      return { ok: false, reason: "testing_claim_conflict", conflicts: opened.conflicts };
    }
    try {
      const control = await this.deps.excubitor.control(serviceCode, input.action);
      return { ok: control.ok, control };
    } finally {
      releaseTestingClaims(this.deps.claims, { sessionId: session.id, service: serviceCode, now: nowSec() });
    }
  }

  /** セッションの作業範囲をコミットする。 判定は委託 run と同じ guard を通る。 */
  async commitWork(input: { sessionId: string; message: string; paths?: readonly string[] }) {
    const session = this.requireSession(input.sessionId);
    return await this.deps.work.commit(session, {
      message: input.message,
      ...(input.paths ? { paths: input.paths } : {}),
    });
  }

  /** repo path から経路を解く (フック向け。 session を要らない)。 */
  routeForRepo(repoPath: string) {
    return this.deps.work.routeForRepo(repoPath);
  }

  /** セッションの repo の提出経路を解く。 */
  submissionRoute(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (!session.repo_path) throw new Error("session has no repo_path; bind the session first");
    return this.deps.work.routeForRepo(session.repo_path);
  }

  /**
   * 経路に沿って成果を提出する。 Revisor Workflow だけが自動で提出でき、
   * それ以外は「この経路では何をすべきか」を返して人間 / セッションに返す。
   */
  async submitWork(sessionId: string, { fastLane = false } = {}) {
    const route = this.submissionRoute(sessionId);
    if (route.route !== "revisor-local-pr") {
      return { submitted: false as const, route };
    }
    const result = await this.submitReview(sessionId, { fastLane });
    return { route, ...result };
  }

  async submitReview(sessionId: string, { fastLane = false } = {}) {
    this.requireSession(sessionId);
    return this.deps.submitLocalPr(sessionId, { fastLane });
  }

  private requireSession(sessionId: string) {
    const session = this.deps.sessions.findSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.status !== "active") throw new Error("implementation tools require an active session");
    return session;
  }
}

function mergeActiveRepos(serialized: string | undefined, repoPath: string): string[] {
  let repos: string[] = [];
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (Array.isArray(parsed)) repos = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // Corrupt historical metadata must not block a new binding.
    }
  }
  const key = repoPath.replace(/\\/g, "/").toLowerCase();
  if (!repos.some((value) => value.replace(/\\/g, "/").toLowerCase() === key)) repos.push(repoPath);
  return repos;
}
