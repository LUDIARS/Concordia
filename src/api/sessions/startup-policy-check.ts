// @spec 初期ポリシーの版と照合
import type { Hono } from "hono";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import type { SessionRow } from "../../shared/types.js";
import { eventBus } from "../../events.js";
import { buildStartupPolicy, readStartupPolicy, startupPolicyDelta, STARTUP_POLICY_KEY } from "../../control/startup-policy.js";
import { SESSION_WORK_POLICY_SOURCE } from "../../control/session-work-policy.js";
import { selectStartupPolicyProject } from "../../control/startup-policy-project.js";
import { createChildLogger } from "../../shared/logger.js";
import { repositorySearchGuidance } from "../../control/repo-search-capabilities.js";
import { isWorkspaceRootCwd } from "../../control/session-work-policy.js";
import { createProjectResolver } from "../../projects/project-resolver.js";

export type PolicyDeps = Pick<SessionsApiDeps, "repo" | "projectCodes" | "resolveProjectStartupWorkflow" | "resolveWorkspaceRoots" | "majorInject">;
const log = createChildLogger("startup-policy");
const samePath = (a: string, b: string) => a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export async function resolveStartupPolicy(deps: PolicyDeps, session: Pick<SessionRow, "repo_path" | "repo_origin" | "branch" | "provider"> & Partial<Pick<SessionRow, "target_project">>, requestedBranch: string | null = null, includeSearch = true): ReturnType<typeof buildStartupPolicy> {
  const projects = deps.projectCodes?.list() ?? [];
  const project = selectStartupPolicyProject(projects, session);
  const roots = deps.resolveWorkspaceRoots?.() ?? [];
  const confirmedRepo = project && !isWorkspaceRootCwd(session.repo_path, roots)
    && createProjectResolver(projects).codeForRepo(session.repo_path) === project.code;
  const searchCapabilitiesText = includeSearch && confirmedRepo
    ? await boundedSearchGuidance(session.repo_path, session.provider).catch(() => "[Cc search environment] 確定済みリポジトリのCcホスト観測を取得できませんでした。作業先端末で検索手段を確認してください。")
    : "";
  return buildStartupPolicy({ repoPath: session.repo_path, repoOrigin: session.repo_origin, observedBranch: session.branch,
    provider: session.provider, pendingSpawn: requestedBranch ? { branch: requestedBranch, project: null } : null,
    workspaceRoots: roots, projectRoot: project?.repo_path, projectCode: project?.code,
    requirements: project ? { ddd: !!project.ddd_enabled, tests: !!project.tests_required,
      ontime: !!project.ontime_tests_required, workContract: !!project.contract_enabled } : null,
    searchCapabilitiesText, majorInject: deps.majorInject });
}

async function boundedSearchGuidance(root: string, provider: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      repositorySearchGuidance(root, provider),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("search observation timed out")), 5_500); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Registration and hook checks share one resolver; hook observations never rebind a session. */
export async function refreshStartupPolicy(deps: PolicyDeps, id: string): Promise<{ revision: string | null; changed: boolean; delivery: "unconfirmed"; stale?: boolean }> {
  const session = deps.repo.findSession(id);
  if (!session) return { revision: null, changed: false, delivery: "unconfirmed" };
  const baseline = readStartupPolicy(session.metadata);
  const { policy } = await resolveStartupPolicy(deps, session, baseline?.fields.requestedBranch || null);
  const current = deps.repo.findSession(id);
  if (!current || current.repo_path !== session.repo_path || current.branch !== session.branch
    || current.repo_origin !== session.repo_origin || current.target_project !== session.target_project
    || current.provider !== session.provider
    || readStartupPolicy(current.metadata)?.revision !== baseline?.revision) {
    return { revision: readStartupPolicy(current?.metadata ?? null)?.revision ?? null, changed: false, delivery: "unconfirmed", stale: true };
  }
  const text = startupPolicyDelta(baseline, policy);
  if (text) {
    const ts = Math.floor(Date.now() / 1000);
    deps.repo.appendEvent({ session_id: id, ts, kind: "inject", payload: { source: SESSION_WORK_POLICY_SOURCE, text, revision: policy.revision } });
    deps.repo.updateMetadata(id, (metadata) => ({ ...metadata, [STARTUP_POLICY_KEY]: policy }));
    eventBus.emit({ type: "session.inject", target_session_id: id, text, source: SESSION_WORK_POLICY_SOURCE, ts });
  }
  return { revision: policy.revision, changed: !!text, delivery: "unconfirmed" };
}

/** Binding remains responsive while registry lookup and resource discovery run. */
export function requestStartupPolicyRefresh(deps: PolicyDeps, id: string): void {
  void refreshStartupPolicy(deps, id).catch((err) => log.warn({ err }, "startup policy refresh failed"));
}

export function registerStartupPolicyCheck(app: Hono, deps: PolicyDeps): void {
  app.post("/:id/startup-policy-check", async (c) => {
    const session = deps.repo.findSession(c.req.param("id"));
    if (!session || session.status !== "active") return c.json({ ok: false, reason: "active_session_required" }, 404);
    const parsed = z.object({ cwd: z.string().min(1).max(4096), branch: z.string().max(256).nullable(),
      provider: z.string().max(80) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, reason: "invalid_observation" }, 400);
    const observed = parsed.data;
    if (!samePath(observed.cwd, session.repo_path) || observed.branch !== session.branch || observed.provider !== session.provider) {
      return c.json({ ok: false, reason: "binding_mismatch", context: "[Cc policy] 実cwd・branch・providerとCc登録が一致しません。対象を照合して登録を直してください。このフックは登録を上書きしていません。" });
    }
    return c.json({ ok: true, ...await refreshStartupPolicy(deps, session.id) });
  });
}
