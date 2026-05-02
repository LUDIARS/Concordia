/**
 * /v1/monitor — frontend 用 集約 endpoint.
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { serializeSession } from "./sessions.js";

export interface MonitorApiDeps {
  repo: SessionsRepo;
}

export function monitorRouter(deps: MonitorApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const active = deps.repo.listSessions({ status: "active" });
    const lost = deps.repo.listSessions({ status: "lost" });
    const recentEnded = deps.repo.listSessions({ status: "ended" }).slice(0, 20);
    const repos = new Map<string, number>();
    for (const s of active) {
      const k = s.repo_origin ?? s.repo_path;
      repos.set(k, (repos.get(k) ?? 0) + 1);
    }
    return c.json({
      active: active.map(serializeSession),
      lost: lost.map(serializeSession),
      recent_ended: recentEnded.map(serializeSession),
      repos: [...repos.entries()].map(([key, count]) => ({ key, count })),
    });
  });

  return app;
}
