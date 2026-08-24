import { Hono } from "hono";
import type { CcTaskRepository } from "../fallback-tasks/repository.js";
import {
  CC_TASK_STATUSES,
  CC_TASK_SYNC_STATES,
  type CcTaskInput,
  type CcTaskPatch,
} from "../fallback-tasks/types.js";

/** @implements spec/feature/cc-task-fallback.md */
export function tasksRouter(repo: CcTaskRepository): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const status = c.req.query("status");
    const syncState = c.req.query("sync_state");
    if (status && !CC_TASK_STATUSES.includes(status as never)) return c.json({ error: "invalid_status" }, 400);
    if (syncState && !CC_TASK_SYNC_STATES.includes(syncState as never)) {
      return c.json({ error: "invalid_sync_state" }, 400);
    }
    return c.json({ tasks: repo.list({ status, syncState }) });
  });
  app.get("/remaining", (c) => c.notFound());
  app.get("/:id", (c) => {
    const task = repo.find(c.req.param("id"));
    return task ? c.json({ task }) : c.json({ error: "not_found" }, 404);
  });
  app.post("/", async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = parseInput(body, false);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const result = repo.create(parsed.value as unknown as CcTaskInput);
    return c.json({ task: result.task, created: result.created }, result.created ? 201 : 200);
  });
  app.patch("/:id", async (c) => {
    const body = await c.req.json<unknown>().catch(() => null);
    const parsed = parseInput(body, true);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.value).length === 0) return c.json({ error: "empty_patch" }, 400);
    const task = repo.update(c.req.param("id"), parsed.value as CcTaskPatch);
    return task ? c.json({ task }) : c.json({ error: "not_found" }, 404);
  });
  return app;
}

function parseInput(body: unknown, patch: boolean): { value: Record<string, unknown> } | { error: string } {
  if (!isRecord(body)) return { error: "invalid_json" };
  const value: Record<string, unknown> = {};
  if (!patch || "title" in body) {
    if (typeof body.title !== "string" || !body.title.trim()) return { error: "title_required" };
    value.title = body.title.trim();
  }
  if (!patch && "source_key" in body) {
    if (body.source_key !== null && typeof body.source_key !== "string") return { error: "invalid_source_key" };
    if (typeof body.source_key === "string" && !body.source_key.trim()) return { error: "invalid_source_key" };
    value.source_key = typeof body.source_key === "string" ? body.source_key.trim() : null;
  }
  for (const field of ["details", "category", "due_at"] as const) {
    if (field in body) {
      if (body[field] !== null && typeof body[field] !== "string") return { error: `invalid_${field}` };
      value[field] = body[field];
    }
  }
  if ("status" in body) {
    const aliases: Record<string, string> = { todo: "open", doing: "in_progress" };
    const status = typeof body.status === "string" ? aliases[body.status] ?? body.status : "";
    if (!CC_TASK_STATUSES.includes(status as never)) return { error: "invalid_status" };
    value.status = status;
  }
  if ("kind" in body) {
    if (body.kind !== "task" && body.kind !== "goal") return { error: "invalid_kind" };
    value.kind = body.kind;
  }
  if ("creator_type" in body) {
    if (body.creator_type !== "human" && body.creator_type !== "ai") return { error: "invalid_creator_type" };
    value.creator_type = body.creator_type;
  }
  return { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
