/** @implements CC-TASK-LINKED-FOLLOWUP — explicit instruction-to-Actio references. */
import type { Hono } from "hono";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import { addSessionTaskLink, readLinkedTaskViews } from "../../work/session-task-links.js";

const LinkSchema = z.object({
  instruction_ref: z.string().trim().min(1).max(256),
  task_reference: z.string().regex(/^actio:[A-Za-z0-9-]+$/),
}).strict();

export function registerTaskLinksRoutes(app: Hono, deps: Pick<SessionsApiDeps, "repo" | "taskStore">): void {
  app.get("/:id/task-links", async (c) => {
    if (!deps.taskStore) return c.json({ error: "actio_unavailable" }, 503);
    const result = await readLinkedTaskViews({ sessions: deps.repo, tasks: deps.taskStore(), sessionId: c.req.param("id") });
    if (result.kind === "not_found") return c.json({ error: "not_found" }, 404);
    if (result.kind === "stale_binding") return c.json({ error: "binding_changed" }, 409);
    return c.json({ links: result.links });
  });

  app.post("/:id/task-links", async (c) => {
    if (!deps.taskStore) return c.json({ error: "actio_unavailable" }, 503);
    const parsed = LinkSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_task_link", detail: parsed.error.flatten() }, 400);
    const result = await addSessionTaskLink({
      sessions: deps.repo, tasks: deps.taskStore(), sessionId: c.req.param("id"),
      instructionRef: parsed.data.instruction_ref, taskReference: parsed.data.task_reference,
    });
    if (result.kind === "not_found") return c.json({ error: "active_session_required" }, 404);
    if (result.kind === "stale_binding") return c.json({ error: "binding_changed" }, 409);
    if (result.kind === "limit") return c.json({ error: "task_link_limit" }, 409);
    if (result.kind === "task_out_of_scope") return c.json({ error: "actio_task_out_of_scope" }, 403);
    if (result.kind === "task_unavailable") return c.json({ error: "actio_task_unavailable" }, 503);
    if (result.kind !== "linked" && result.kind !== "existing") return c.json({ error: "task_link_failed" }, 500);
    return c.json({ link: result.link, existing: result.kind === "existing" }, result.kind === "linked" ? 201 : 200);
  });
}
