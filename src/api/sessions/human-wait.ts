/** @implements CC-TASK-LINKED-FOLLOWUP — explicit human decision wait. */
import type { Hono } from "hono";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import { HUMAN_WAIT_KEY, readHumanWait } from "../../control/human-wait.js";
import { readSubsidiaryId } from "../../shared/subsidiary-id.js";

const WaitSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  task_references: z.array(z.string().regex(/^actio:[A-Za-z0-9-]+$/)).max(16),
}).strict();

export function registerHumanWaitRoutes(app: Hono, deps: Pick<SessionsApiDeps, "repo">): void {
  app.get("/:id/human-wait", (c) => {
    const session = deps.repo.findSession(c.req.param("id"));
    return session ? c.json({ human_wait: readHumanWait(session.metadata) }) : c.json({ error: "not_found" }, 404);
  });
  app.post("/:id/human-wait", async (c) => {
    const id = c.req.param("id");
    const session = deps.repo.findSession(id);
    if (!session || session.status !== "active") return c.json({ error: "active_session_required" }, 404);
    const parsed = WaitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_human_wait", detail: parsed.error.flatten() }, 400);
    const latest = deps.repo.findSession(id);
    if (!latest || latest.status !== "active" || latest.repo_path !== session.repo_path
      || latest.repo_origin !== session.repo_origin || latest.branch !== session.branch
      || latest.target_project !== session.target_project
      || readSubsidiaryId(latest.metadata) !== readSubsidiaryId(session.metadata)) {
      return c.json({ error: "binding_changed" }, 409);
    }
    const state = { active: true, summary: parsed.data.summary,
      task_references: [...new Set(parsed.data.task_references)], since: Date.now() };
    deps.repo.updateMetadata(id, (metadata) => ({ ...metadata, [HUMAN_WAIT_KEY]: state }));
    return c.json({ human_wait: state });
  });
}
