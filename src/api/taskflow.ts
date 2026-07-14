import { Hono } from "hono";
import type { TaskMdStore, TaskStatus } from "../taskflow/md-store.js";

const STATUSES: TaskStatus[] = ["pending", "delegated", "done", "cancelled"];

export function taskflowRouter(input: { store: TaskMdStore }): Hono {
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
  return app;
}
