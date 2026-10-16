import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import type { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { ExcubitorClient, ServiceAction } from "../excubitor/client.js";
import type { LocalPrSubmissionResult } from "../pr/local-pr-submission.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";
import { inspectImplementationRepo, isWithinWorkspace } from "./repo-context.js";
import type { WorkSubmissionService } from "../work-submission/service.js";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { createImplementationWorktree, type CreateWorktreeInput } from "./worktree.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { EXPLICIT_CONTEXT_BINDING_KEY } from "../control/inject-context-presence.js";
import { selectOwnedWorktree } from "./switch-worktree.js";
import { ImplementationBindFailure, type BindStage, type BindReason } from "./bind-failure.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { createChildLogger } from "../shared/logger.js";
import {
  EXPLICIT_WORKING_BRANCH_METADATA_KEY,
  isWorkspaceRootCwd,
  WORKSPACE_ROOT_METADATA_KEY,
} from "../control/session-work-policy.js";

const nowSec = (): number => Math.floor(Date.now() / 1000);
const log = createChildLogger("implementation-bind");

async function bindingStep<T>(stage: BindStage, reason: BindReason, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof ImplementationBindFailure) throw error;
    throw new ImplementationBindFailure(stage, reason, error);
  }
}

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
  onContextBindingChanged?: (sessionId: string) => void;
}

/** Stateless fast paths over existing Cc / Ex / Revisor state owners. */
export class ImplementationToolsService {
  constructor(private readonly deps: ImplementationToolsDeps) {}

  async switchBranch(input: CreateWorktreeInput) {
    this.requireSession(input.sessionId);
    const cwd = await selectOwnedWorktree(input, this.deps.projectCodes.list(), this.deps.resolveWorkspaceRoots());
    await this.bind({ sessionId: input.sessionId, cwd, task: input.task });
    return { ok: true, cwd, branch: input.branch };
  }

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
    const session = this.deps.sessions.findSession(input.sessionId);
    if (!session) throw new ImplementationBindFailure("session", "session_not_found");
    if (session.status !== "active") throw new ImplementationBindFailure("session", "session_inactive");
    const task = input.task.trim();
    if (!task) throw new ImplementationBindFailure("session", "invalid_task");
    const workspaceRoots = this.deps.resolveWorkspaceRoots();
    if (!await isWithinWorkspace(input.cwd, workspaceRoots)) {
      throw new ImplementationBindFailure("workspace", "workspace_denied");
    }
    const context = await bindingStep("repository", "git_failed", () => inspectImplementationRepo(input.cwd));
    if (!await isWithinWorkspace(context.repoPath, workspaceRoots)) {
      throw new ImplementationBindFailure("workspace", "workspace_denied");
    }
    // 登録コマンドの直後から効かせるため、snapshot を cache せず bind ごとに DB を読む。
    const canonical = repositoryKey(await bindingStep("project", "identity_unavailable", () => mainRepositoryKey(context.repoPath)));
    const matches = this.deps.projectCodes.list().filter(row => repositoryKey(row.repo_path) === canonical);
    if (!matches.length) throw new ImplementationBindFailure("project", "project_not_registered");
    if (matches.length !== 1) throw new ImplementationBindFailure("project", "project_ambiguous");
    const project = matches[0]!;
    const projectCode = project.code;
    const claimedTask = task.startsWith(`[${projectCode}]`) ? task : `[${projectCode}] ${task}`;
    const activeRepos = mergeActiveRepos(session.active_repos, context.repoPath);
    const patch = {
      current_task: claimedTask,
      branch: context.branch,
      repo_path: context.repoPath,
      repo_origin: context.repoOrigin,
      target_project: project.repo_path,
      active_repos: activeRepos,
    };
    const metadata = {
      [EXPLICIT_WORKING_BRANCH_METADATA_KEY]: context.branch,
      [EXPLICIT_CONTEXT_BINDING_KEY]: {
        repoPath: context.repoPath,
        repoOrigin: context.repoOrigin,
        branch: context.branch,
        projectCode,
      },
      ...(isWorkspaceRootCwd(session.repo_path, workspaceRoots)
        ? { [WORKSPACE_ROOT_METADATA_KEY]: session.repo_path }
        : {}),
    };
    const committed = await bindingStep("persistence", "persistence_failed", async () =>
      this.deps.sessions.commitImplementationBinding({ expected: session, patch, metadata,
        event: { ts: nowSec(), payload: { project_code: projectCode, task: claimedTask, branch: context.branch } } }));
    if (!committed) throw new ImplementationBindFailure("persistence", "stale_session");
    let notificationDeferred = false;
    try { this.deps.onContextBindingChanged?.(session.id); }
    catch {
      // Binding is committed; policy notification can be refreshed without replaying the write.
      notificationDeferred = true;
      log.warn({ stage: "notification" }, "binding committed; context notification deferred");
    }
    // PATCH /v1/sessions/:id と同じく task 変更を通知する。 セッション契約 (contract/lifecycle.ts) は
    // session.started / session.task_changed にしか反応しないので、 ここで出さないと Castra 等で起動して
    // implement begin で契約対象プロジェクトへ入ったセッションに契約が作られず、 編集ゲートの
    // contract-incomplete が全編集を拒否し続ける (2026-10-06)。 作業場所だけ変わった場合も契約対象が
    // 変わりうるので通知する。
    const bindingMoved = context.repoPath !== session.repo_path || (context.repoOrigin ?? null) !== (session.repo_origin ?? null);
    if (claimedTask !== session.current_task || bindingMoved) {
      eventBus.emit({
        type: "session.task_changed",
        session_id: session.id,
        previous_task: session.current_task ?? null,
        current_task: claimedTask,
        ts: nowSec(),
      });
    }
    return { ok: true, project_code: projectCode, task: claimedTask, branch: context.branch,
      ...(notificationDeferred ? { notification: "deferred" as const } : {}) };
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
  async submissionRoute(sessionId: string) {
    const session = this.requireSession(sessionId);
    if (!session.repo_path) throw new Error("session has no repo_path; bind the session first");
    return this.deps.work.routeForRepo(session.repo_path);
  }

  /**
   * 経路に沿って成果を提出する。 Revisor Workflow は local PR、GitHub Workflow は
   * push と GitHub PR。 それ以外は「この経路では何をすべきか」を返して人間 / セッションに返す。
   */
  async submitWork(sessionId: string, { fastLane = false } = {}) {
    const route = await this.submissionRoute(sessionId);
    if (route.route === "github-pr") {
      const result = await this.deps.work.submitGithubPr(this.requireSession(sessionId));
      return { route, ...result };
    }
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
