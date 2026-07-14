import { Hono } from "hono";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TaskMdStore, TaskStatus } from "../taskflow/md-store.js";
import { buildTaskflowOverview, countTaskflowRows } from "../taskflow/overview.js";

const STATUSES: TaskStatus[] = ["pending", "delegated", "done", "cancelled"];

export function taskflowRouter(input: {
  store: TaskMdStore;
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
      return !status || document.frontmatter.status === status;
    }).map((document) => ({
      path: input.store.relativePath(document),
      repo_path: document.repoPath,
      title: document.title,
      ...document.frontmatter,
    }));
    return c.json({ tasks });
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
