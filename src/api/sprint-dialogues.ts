import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { projectionSchema, acknowledgementSchema, dialogueReceipt, DialogueConflict } from "../sprint-dialogues/domain.js";
import type { SprintDialoguesRepository } from "../sprint-dialogues/repository.js";

/** Trusted service projection/receipt API. There is deliberately no human-event creation route. */
export function sprintDialoguesRouter(repo: SprintDialoguesRepository, localRequest?: () => boolean): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 5 * 1024 * 1024, onError: c => c.json({ error: "sprint request too large" }, 413) }));
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    let local = false;
    try { local = localRequest ? localRequest() : ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(getConnInfo(c).remote.address ?? ""); } catch { /* no transport identity */ }
    if (!local || ["origin", "sec-fetch-site", "forwarded", "x-forwarded-for", "cf-connecting-ip"].some(h => c.req.header(h))) return c.json({ error: "local service integration only" }, 403);
    await next();
  });
  app.onError((error, c) => c.json({ error: error instanceof DialogueConflict ? error.message : "Sprint dialogue operation failed" }, error instanceof DialogueConflict ? 409 : 500));
  app.get("/events", (c) => {
    const n = Number(c.req.query("limit") ?? 100);
    return c.json({ events: repo.pendingEvents(Number.isInteger(n) ? Math.max(1, Math.min(n, 100)) : 100) });
  });
  app.post("/events/:id/ack", async c => {
    const value = acknowledgementSchema.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({ error: "invalid acknowledgement" }, 400);
    if (!repo.event(c.req.param("id"))) return c.json({ error: "event not found" }, 404);
    repo.acknowledge(c.req.param("id"), value.data);
    return c.json({ ok: true });
  });
  app.get("/:key", c => {
    const dialogue = repo.find(c.req.param("key"));
    return dialogue ? c.json({ dialogue: dialogueReceipt(dialogue) }) : c.json({ error: "dialogue not found" }, 404);
  });
  app.put("/:key", async c => {
    const value = projectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!value.success || value.data.dialogueKey !== c.req.param("key")) return c.json({ error: "invalid sprint projection" }, 400);
    return c.json({ dialogue: dialogueReceipt(repo.publish(value.data)) });
  });
  return app;
}
