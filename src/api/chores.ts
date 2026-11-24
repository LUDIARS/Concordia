import { Hono } from "hono";
import { z } from "zod";
import type { ChoresService } from "../chores/service.js";

/**
 * 雑務の API。Cc v5 で新規受付をやめ、依頼窓口 (/v1/desk) にまとめた (2026-11-24 neco 決定「依頼窓口にまとめる」)。
 * 既存 run の一覧・配達・OK / Continue は残す (処理中の雑務を途中で切らない)。
 */
export function choresRouter(service: ChoresService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("cache-control", "no-store"); await next(); });
  app.get("/", (c) => c.json({ runs: service.repo.list() }));
  app.get("/deliveries", (c) => c.json({ runs: service.repo.undelivered() }));
  app.post("/", (c) => c.json({ error: "chores_retired_use_desk", detail: "雑務の新規受付は終了しました。依頼窓口 (/desk、POST /v1/desk/requests) を使ってください。" }, 410));
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
