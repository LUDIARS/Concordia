/** @implements spec/feature/shared-startup-context.md — deterministic push hook gate */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { RevisorRepositoryAdmin } from "../pr/revisor-repository-client.js";
import { inspectImplementationRepo, isWithinWorkspace } from "../implementation-tools/repo-context.js";
import { selectProjectStartupWorkflow } from "../control/project-startup-workflow.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { PushWarningSchema, isWarningRemoteAllowed, type PushWarningPrompt, type PushWarningDecision } from "../control/push-warning.js";
import { requestPushWarning } from "../control/push-warning-dialog.js";

export function sessionPushCheckRouter(deps: {
  sessions: SessionsRepo;
  revisor?: Pick<RevisorRepositoryAdmin, "listRepositories">;
  workspaceRoots: () => string[];
  requestWarning?: (prompt: PushWarningPrompt) => Promise<PushWarningDecision>;
  /**
   * 登録時に控えた新規プロジェクトを、最初に push が許可された時点で 1 回だけ本社へ通知する
   * (spec/feature/project-created-notify.md)。未注入なら通知しない。
   */
  notifyProjectPushed?: (repository: string) => Promise<void>;
}): Hono {
  const app = new Hono();
  app.post("/:id/push-check", async (c) => {
    const session = deps.sessions.findSession(c.req.param("id"));
    if (!session || session.status !== "active") return c.json({ allowed: false, reason: "Active session required" });
    const parsed = z.object({ cwd: z.string().min(1).max(4096), push: z.unknown().optional() })
      .strict().safeParse(await c.req.json().catch(() => null));
    let allowed = false;
    let reason = "Project workflow or checkout could not be verified";
    let repoOrigin = "";
    try {
      if (parsed.success && deps.revisor && await isWithinWorkspace(parsed.data.cwd, deps.workspaceRoots())) {
        const repo = await inspectImplementationRepo(parsed.data.cwd);
        const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        if (norm(repo.repoPath) === norm(session.repo_path) && repo.branch === session.branch
          && normalizeRepoOrigin(repo.repoOrigin ?? "").toLowerCase() === normalizeRepoOrigin(session.repo_origin ?? "").toLowerCase()
          && !deps.workspaceRoots().some((root) => norm(root) === norm(repo.repoPath))) {
          repoOrigin = normalizeRepoOrigin(repo.repoOrigin ?? "");
          const workflow = selectProjectStartupWorkflow(await deps.revisor.listRepositories(), repo.repoPath, repo.repoOrigin);
          allowed = workflow === "github";
          reason = workflow === "revisor" ? "Revisor Workflow: submit a local PR through Cc; session push is blocked"
            : allowed ? "GitHub Workflow; existing Git hooks still apply" : "Project workflow is unknown; push blocked";
          const warning = PushWarningSchema.safeParse(parsed.data.push);
          const push = warning.success ? warning.data : null;
          if (workflow === "revisor" && push && isWarningRemoteAllowed(push.remoteUrl, repo.repoOrigin)) {
            const prompt = { sessionId: session.id, repoPath: repo.repoPath, branch: repo.branch, push };
            const requestId = randomUUID();
            deps.sessions.appendEvent({ session_id: session.id, ts: Math.floor(Date.now() / 1000),
              kind: "push_warning_requested", payload: { requestId, ...prompt } });
            const decision = await (deps.requestWarning ?? requestPushWarning)(prompt);
            deps.sessions.appendEvent({ session_id: session.id, ts: Math.floor(Date.now() / 1000),
              kind: "push_warning_decided", payload: { requestId, ...prompt, decision } });
            reason = `WARNING: ${decision}; push blocked`;
            if (decision === "approved") {
              // Human wait is an asynchronous boundary: never authorize a rebound/ended session.
              const current = deps.sessions.findSession(session.id);
              const checkout = await inspectImplementationRepo(parsed.data.cwd);
              const roots = deps.workspaceRoots();
              const sameBinding = current?.status === "active" && current.branch === session.branch
                && current.repo_path === session.repo_path && current.repo_origin === session.repo_origin
                && checkout.repoPath === repo.repoPath && checkout.branch === repo.branch && checkout.repoOrigin === repo.repoOrigin;
              allowed = sameBinding && await isWithinWorkspace(checkout.repoPath, roots)
                && !roots.some((root) => norm(root) === norm(checkout.repoPath))
                && selectProjectStartupWorkflow(await deps.revisor.listRepositories(), checkout.repoPath, checkout.repoOrigin) === "revisor";
              reason = allowed ? "WARNING approved for this push only; existing Git hooks still apply"
                : "Repository/session policy changed during WARNING; push blocked";
            }
          }
        }
      }
    } catch { /* Never turn an unavailable policy service into push permission. */ }
    deps.sessions.appendEvent({ session_id: session.id, ts: Math.floor(Date.now() / 1000), kind: "push_hook_decision",
      payload: { allowed, reason } });
    // 通知は push の可否に影響させない。控えが無ければ何もしないので、既存リポでは走らない。
    if (allowed && repoOrigin) {
      await deps.notifyProjectPushed?.(repoOrigin).catch(() => { /* 配送失敗で push を止めない */ });
    }
    return c.json({ allowed, reason });
  });
  return app;
}
