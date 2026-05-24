/**
 * /v1/tasks — cross-session view over session_task_records.
 *
 *   GET /v1/tasks/remaining?repo=<path>[&limit=N]
 *      sessions が完了させずに終わった (status != 'completed') task の一覧.
 *      repo を渡すと sessions.repo_path / repo_origin 一致のものに絞る.
 *
 * Per-session のリスト (GET /v1/sessions/:id/tasks) は sessions router 側にある.
 */

import { Hono } from "hono";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";

export interface TasksApiDeps {
  records: SessionTaskRecordsRepo;
}

export function tasksRouter(deps: TasksApiDeps): Hono {
  const app = new Hono();

  app.get("/remaining", (c) => {
    const repo = (c.req.query("repo") ?? "").trim();
    const limitRaw = Number(c.req.query("limit"));
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 1000 ? limitRaw : 200;
    const items = deps.records.listRemaining({
      repo_path: repo || undefined,
      limit,
    });
    return c.json({ items, repo: repo || null, limit });
  });

  return app;
}
