import { Hono } from "hono";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TaskMdStore, TaskStatus } from "../taskflow/md-store.js";
import type { TaskflowStateStore, TaskRuntimePatch } from "../taskflow/state-store.js";
import { buildTaskflowOverview, countTaskflowRows } from "../taskflow/overview.js";

const STATUSES: TaskStatus[] = ["pending", "delegated", "done", "cancelled"];

/** 明示 null を「消す」として通し、 未指定は変更しない。 */
function nullableStringField(
  body: Record<string, unknown> | null,
  field: "assignee" | "owner" | "source_session" | "delegation_run_id",
): Partial<TaskRuntimePatch> {
  if (!body || !(field in body)) return {};
  const value = body[field];
  if (value === null) return { [field]: null };
  return typeof value === "string" && value.trim() ? { [field]: value.trim() } : {};
}

function prNumberField(body: Record<string, unknown> | null): Partial<TaskRuntimePatch> {
  if (!body || !("pr_number" in body)) return {};
  const value = body.pr_number;
  if (value === null) return { pr_number: null };
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? { pr_number: value } : {};
}

export function taskflowRouter(input: {
  store: TaskMdStore;
  state: TaskflowStateStore;
  sessions: SessionsRepo;
  delegation: DelegationRepo;
  prs: PrRecordsRepo;
}): Hono {
  const app = new Hono();
  app.get("/tasks", async (c) => {
    const project = c.req.query("project")?.trim().toLowerCase();
    const status = c.req.query("status")?.trim() as TaskStatus | undefined;
    if (status && !STATUSES.includes(status)) return c.json({ error: "invalid_status" }, 400);
    const tasks = (await input.store.scan()).filter((document) => {
      if (project && document.frontmatter.project.toLowerCase() !== project) return false;
      return !status || (document.runtime?.status ?? "pending") === status;
    }).map((document) => ({
      path: input.store.relativePath(document),
      repo_path: document.repoPath,
      title: document.title,
      ...document.frontmatter,
      ...document.runtime,
    }));
    return c.json({ tasks });
  });
  // runtime state の唯一の書き込み口。 md へ status を書き戻さない運用なので、
  // 状態遷移 (pending→delegated→done/cancelled) はここを通す。
  app.patch("/tasks/state", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const repoPath = typeof body?.repo_path === "string" ? body.repo_path.trim() : "";
    const taskPath = typeof body?.task_path === "string" ? body.task_path.trim() : "";
    if (!repoPath || !taskPath) return c.json({ error: "repo_path and task_path are required" }, 400);
    const status = body?.status;
    if (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status as TaskStatus))) {
      return c.json({ error: "invalid_status" }, 400);
    }
    const patch: TaskRuntimePatch = {
      ...(status === undefined ? {} : { status: status as TaskStatus }),
      ...nullableStringField(body, "assignee"),
      ...nullableStringField(body, "owner"),
      ...nullableStringField(body, "source_session"),
      ...nullableStringField(body, "delegation_run_id"),
      ...prNumberField(body),
    };
    const key = { repoPath, taskPath };
    if (!input.state.update(key, patch)) {
      // 行が無い = まだ一度も scan されていない task。 md を先に置く運用なので 404 で返す。
      return c.json({ error: input.state.find(key) ? "no_changes" : "not_found" }, 404);
    }
    return c.json({ ok: true, state: input.state.find(key) });
  });
  app.get("/overview", async (c) => {
    const project = c.req.query("project")?.trim().toLowerCase();
    const status = c.req.query("status")?.trim() as TaskStatus | undefined;
    if (status && !STATUSES.includes(status)) return c.json({ error: "invalid_status" }, 400);
    const overview = buildTaskflowOverview({
      documents: await input.store.scan(),
      relativePath: (document) => input.store.relativePath(document),
      sessions: input.sessions.listSessions({}),
      runs: input.delegation.recentRuns(1000),
      prs: input.prs.list({ limit: 500 }),
    });
    const tasks = overview.tasks.filter((task) => {
      if (project && task.project.toLowerCase() !== project) return false;
      return !status || task.status === status;
    });
    return c.json({
      ...overview,
      counts: countTaskflowRows(tasks),
      tasks,
    });
  });
  return app;
}
