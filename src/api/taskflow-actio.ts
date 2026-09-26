import type { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TaskStore } from "../taskflow/store.js";
import type { TaskflowStateStore } from "../taskflow/state-store.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";

const Create = z.object({
  session_id: z.string().min(1), request_id: z.string().uuid(),
  title: z.string().trim().min(1).max(500), body: z.string().min(1).max(100_000),
  kind: z.string().min(1).max(50).default("実装"), memory_links: z.array(z.string().max(2000)).max(50).default([]),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

const Import = Create.omit({ request_id: true }).extend({
  source: z.enum(["memoria", "markdown"]), source_id: z.string().min(1).max(2000),
  status: z.enum(["pending", "delegated", "done", "cancelled"]),
}).strict();

/** Task contents cross this boundary only on explicit create/read requests. */
export function registerActioTaskRoutes(app: Hono, deps: {
  store: TaskStore; sessions: SessionsRepo; state: TaskflowStateStore;
}): void {
  app.post("/tasks/import", bodyLimit({ maxSize: 500_000 }), async (c) => {
    if (!deps.store.create) return c.json({ error: "Actio task store required" }, 503);
    const parsed = Import.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_task_import" }, 400);
    const input = parsed.data;
    const session = deps.sessions.findSession(input.session_id);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const task = await deps.store.create({
      repoPath: session.repo_path, subsidiaryId: readSubsidiaryId(session.metadata),
      sourceRef: `import:${input.source}:${input.source_id}`,
      title: input.title, body: input.body, kind: input.kind, memoryLinks: input.memory_links, status: input.status, dueAt: input.due_at,
    });
    return c.json({ reference: task.path, repo_path: task.repoPath, status: task.runtime?.status }, 201);
  });
  app.post("/tasks", bodyLimit({ maxSize: 500_000 }), async (c) => {
    if (!deps.store.create) return c.json({ error: "Actio task store required" }, 503);
    const parsed = Create.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_task_input" }, 400);
    const input = parsed.data;
    const session = deps.sessions.findSession(input.session_id);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const task = await deps.store.create({
      repoPath: session.repo_path, subsidiaryId: readSubsidiaryId(session.metadata),
      sourceRef: `session:${session.id}:${input.request_id}`,
      issuedBySessionId: session.id,
      title: input.title, body: input.body, kind: input.kind, memoryLinks: input.memory_links, dueAt: input.due_at,
    });
    return c.json({ reference: task.path, repo_path: task.repoPath, status: task.runtime?.status }, 201);
  });

  app.get("/tasks/content", async (c) => {
    if (!deps.store.read) return c.json({ error: "Actio task store required" }, 503);
    const sessionId = c.req.query("session_id");
    const reference = c.req.query("reference");
    if (!sessionId || !reference) return c.json({ error: "session_id and reference required" }, 400);
    const session = deps.sessions.findSession(sessionId);
    if (!session) return c.json({ error: "session_not_found" }, 404);
    const task = await deps.store.read(session.repo_path, reference, readSubsidiaryId(session.metadata));
    return c.json({ reference: task.path, title: task.title, body: task.body, memory_links: task.frontmatter.memory_links, status: task.runtime?.status,
      issued_by_session_id: task.frontmatter.issued_by_session_id ?? null,
      working_session_id: task.frontmatter.working_session_id ?? null });
  });
}
