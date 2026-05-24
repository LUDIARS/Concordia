/**
 * /v1/machines API.
 *
 * Aggregates sessions by `host` so the Web UI can present a "what's running
 * where" overview before drilling into a specific session. v0.1 surface:
 *
 *   GET /v1/machines           — list of hosts + per-status session counts
 *   GET /v1/machines/:host     — sessions on a specific host (filterable by status)
 *
 * Spawning / stopping sessions lives in /v1/admin/{spawn,stop}-session
 * (loopback-trusted; see app.ts).
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionStatus } from "../shared/types.js";
import { serializeSession } from "./sessions.js";

export interface MachinesApiDeps {
  repo: SessionsRepo;
}

export function machinesRouter(deps: MachinesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const machines = deps.repo.listMachines();
    return c.json({ machines });
  });

  app.get("/:host", (c) => {
    const host = c.req.param("host");
    const status = c.req.query("status") as SessionStatus | undefined;
    const sessions = deps.repo.listSessions({ host, status });
    return c.json({
      host,
      sessions: sessions.map(serializeSession),
    });
  });

  return app;
}
