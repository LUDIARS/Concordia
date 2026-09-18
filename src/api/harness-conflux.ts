import { Hono } from "hono";
import { z } from "zod";
import type { ConfluxService } from "../harness/reliability/conflux-service.js";
const Schema = z.object({ session_id: z.string().min(1).max(128), selection: z.unknown() });
/** Same local harness trust boundary as /gate. Selection never grants execution permissions. */
export function harnessConfluxRouter(service: ConfluxService): Hono {
  const app = new Hono();
  app.post("/select", async c => {
    const body = Schema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_selection" }, 400);
    try { service.select(body.data.session_id, body.data.selection); }
    catch (e) { return c.json({ error: e instanceof Error ? e.message : "selection_failed" }, 409); }
    return c.json({ selected: true, checked: false });
  });
  return app;
}
