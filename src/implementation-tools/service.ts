import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import type { ExcubitorClient, ServiceAction } from "../excubitor/client.js";
import type { LocalPrSubmissionResult } from "../pr/local-pr-submission.js";
import { createProjectResolver, type ProjectResolver } from "../projects/project-resolver.js";
import { openTestingClaim, releaseTestingClaims } from "../testing/claim-lifecycle.js";
import { inspectImplementationRepo, isWithinWorkspace } from "./repo-context.js";

const nowSec = (): number => Math.floor(Date.now() / 1000);

export interface ImplementationToolsDeps {
  sessions: SessionsRepo;
  claims: TestingClaimsRepo;
  excubitor: Pick<ExcubitorClient, "control">;
  submitLocalPr: (sessionId: string) => Promise<LocalPrSubmissionResult | {
    submitted: false;
    reason: "session_not_found";
  }>;
  resolveWorkspaceRoots: () => string[];
  log: { warn(message: string): void };
}

/** Stateless fast paths over existing Cc / Ex / Revisor state owners. */
export class ImplementationToolsService {
  private projectResolver: ProjectResolver | null = null;
  private projectResolverKey = "";

  constructor(private readonly deps: ImplementationToolsDeps) {}

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
    const resolver = this.resolveProjectResolver(workspaceRoots);
    const projectCode = resolver.codeForRepo(context.repoPath);
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

  async submitReview(sessionId: string) {
    this.requireSession(sessionId);
    return this.deps.submitLocalPr(sessionId);
  }

  private requireSession(sessionId: string) {
    const session = this.deps.sessions.findSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (session.status !== "active") throw new Error("implementation tools require an active session");
    return session;
  }

  private resolveProjectResolver(roots = this.deps.resolveWorkspaceRoots()): ProjectResolver {
    const key = JSON.stringify(roots);
    if (!this.projectResolver || key !== this.projectResolverKey) {
      this.projectResolver = createProjectResolver(roots, {
        warn: (message) => this.deps.log.warn(message),
      });
      this.projectResolverKey = key;
    }
    return this.projectResolver;
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
