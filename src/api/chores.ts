import { Hono } from "hono";
import { z } from "zod";
import type { ChoresService } from "../chores/service.js";

const submission = z.object({ request_key: z.string().min(1).max(120), prompt: z.string().trim().min(1).max(16_000), provider: z.enum(["claude", "codex"]) });
export function choresRouter(service: ChoresService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  app.get("/", (c) => c.json({ runs: service.repo.list() }));
  app.get("/deliveries", (c) => c.json({ runs: service.repo.undelivered() }));
  app.post("/", async (c) => {
    const parsed = submission.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "依頼・実行CLI・受付キーを確認してください。" }, 400);
    try {
      const { request_key, prompt, provider } = parsed.data;
      return c.json({ run: service.submit(request_key, prompt, provider) }, 202);
    } catch (error) { return c.json({ error: String(error) }, 409); }
  });
  app.post("/:id/choice", async (c) => {
    const parsed = z.object({ action: z.enum(["ok", "continue"]) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "action must be ok or continue" }, 400);
    try { return c.json({ run: await service.choose(c.req.param("id"), parsed.data.action) }); }
    catch (error) { return c.json({ error: String(error) }, 409); }
  });
  app.post("/:id/delivery", async (c) => {
    const parsed = z.object({ revision: z.number().int().positive(), message_id: z.string().regex(/^\d{1,25}$/) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid delivery receipt" }, 400);
    if (!service.repo.find(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    service.repo.delivered(c.req.param("id"), parsed.data.revision, parsed.data.message_id);
    return c.json({ ok: true });
  });
  return app;
}
