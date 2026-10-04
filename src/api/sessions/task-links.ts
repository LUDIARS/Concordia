/** @implements CC-TASK-LINKED-FOLLOWUP — explicit instruction-to-Actio references. */
import type { Hono } from "hono";
import { z } from "zod";
import type { SessionsApiDeps } from "./deps.js";
import { addSessionTaskLink, readLinkedTaskViews } from "../../work/session-task-links.js";

const LinkSchema = z.object({
  instruction_ref: z.string().trim().min(1).max(256),
  task_reference: z.string().regex(/^actio:[A-Za-z0-9-]+$/),
}).strict();

export function registerTaskLinksRoutes(app: Hono, deps: Pick<SessionsApiDeps, "repo" | "taskStore" | "syncInstructionFragments" | "isPrivateConsultation">): void {
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
    let fragments: import("../../work/instruction-fragments.js").FragmentSyncResult = { state: "unavailable" };
    if (deps.isPrivateConsultation?.(c.req.param("id"))) {
      fragments = { state: "excluded_private" };
    } else if (deps.syncInstructionFragments && deps.isPrivateConsultation) {
      try {
        const store = deps.taskStore();
        const reader = store.readReference?.bind(store) ?? store.read?.bind(store);
        if (!reader) throw new Error("task_read_unavailable");
        const task = await reader(result.link.repo_path, result.link.task_reference, result.link.subsidiary_id);
        fragments = await deps.syncInstructionFragments({ repo: result.link.repo_path, origin: result.link.repo_origin,
          reference: result.link.task_reference, title: task.title, body: task.body, kind: task.frontmatter.kind });
      } catch { /* Actio/Pf outage is explicit in the response; retry the same link, not a new task. */ }
    }
    return c.json({ link: result.link, existing: result.kind === "existing", fragments }, result.kind === "linked" ? 201 : 200);
  });
}
