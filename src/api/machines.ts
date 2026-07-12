/**
 * /v1/machines API.
 *
 * Aggregates sessions by `host` so the Web UI can present a "what's running
 * where" overview before drilling into a specific session. v0.1 surface:
 *
 *   GET /v1/machines           — list of hosts + per-status session counts
 *
 * Spawning / stopping sessions lives in /v1/admin/{spawn,stop}-session
 * (loopback-trusted; see app.ts).
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";

export interface MachinesApiDeps {
  repo: SessionsRepo;
}

export function machinesRouter(deps: MachinesApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const machines = deps.repo.listMachines();
    return c.json({ machines });
  });

  return app;
}
