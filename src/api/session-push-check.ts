/** @implements spec/feature/shared-startup-context.md — deterministic push hook gate */
import { Hono } from "hono";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { RevisorRepositoryAdmin } from "../pr/revisor-repository-client.js";
import { inspectImplementationRepo, isWithinWorkspace } from "../implementation-tools/repo-context.js";
import { selectProjectStartupWorkflow } from "../control/project-startup-workflow.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";

export function sessionPushCheckRouter(deps: {
  sessions: SessionsRepo;
  revisor?: Pick<RevisorRepositoryAdmin, "listRepositories">;
  workspaceRoots: () => string[];
}): Hono {
  const app = new Hono();
  app.post("/:id/push-check", async (c) => {
    const session = deps.sessions.findSession(c.req.param("id"));
    if (!session || session.status !== "active") return c.json({ allowed: false, reason: "Active session required" });
    const parsed = z.object({ cwd: z.string().min(1).max(4096) }).strict().safeParse(await c.req.json().catch(() => null));
    let allowed = false;
    let reason = "Project workflow or checkout could not be verified";
    try {
      if (parsed.success && deps.revisor && await isWithinWorkspace(parsed.data.cwd, deps.workspaceRoots())) {
        const repo = await inspectImplementationRepo(parsed.data.cwd);
        const norm = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
        if (norm(repo.repoPath) === norm(session.repo_path) && repo.branch === session.branch
          && normalizeRepoOrigin(repo.repoOrigin ?? "").toLowerCase() === normalizeRepoOrigin(session.repo_origin ?? "").toLowerCase()
          && !deps.workspaceRoots().some((root) => norm(root) === norm(repo.repoPath))) {
          const workflow = selectProjectStartupWorkflow(await deps.revisor.listRepositories(), repo.repoPath, repo.repoOrigin);
          allowed = workflow === "github";
          reason = workflow === "revisor" ? "Revisor Workflow: submit a local PR through Cc; session push is blocked"
            : allowed ? "GitHub Workflow; existing Git hooks still apply" : "Project workflow is unknown; push blocked";
        }
      }
    } catch { /* Never turn an unavailable policy service into push permission. */ }
    deps.sessions.appendEvent({ session_id: session.id, ts: Math.floor(Date.now() / 1000), kind: "push_hook_decision",
      payload: { allowed, reason } });
    return c.json({ allowed, reason });
  });
  return app;
}
