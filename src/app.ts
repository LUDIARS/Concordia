/**
 * Hono app factory.
 */

import { Hono } from "hono";
import type { SessionsRepo } from "./db/sessions-repo.js";
import type { ConcordiaConfig } from "./shared/config.js";
import { sessionsRouter } from "./api/sessions.js";
import { reportsRouter } from "./api/reports.js";
import { monitorRouter } from "./api/monitor.js";

export interface AppDeps {
  repo: SessionsRepo;
  config: ConcordiaConfig;
  startedAt: string;
  sweeperRunOnce: () => void;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "concordia", version: "0.1.0", started_at: deps.startedAt }),
  );

  app.route("/v1/sessions", sessionsRouter({ repo: deps.repo, config: deps.config }));
  app.route("/v1/reports", reportsRouter({ repo: deps.repo, config: deps.config }));
  app.route("/v1/monitor", monitorRouter({ repo: deps.repo }));

  app.post("/v1/sweeper/run", (c) => {
    deps.sweeperRunOnce();
    return c.json({ ok: true });
  });

  return app;
}
