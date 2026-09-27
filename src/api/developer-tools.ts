import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ToolInput, failure } from "../developer-tools/contracts.js";
import { toolCatalog } from "../developer-tools/catalog.js";
import type { DeveloperToolsService } from "../developer-tools/service.js";

export function developerToolsRouter(service: Pick<DeveloperToolsService, "execute">): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/catalog", c => c.json(toolCatalog()));
  app.post("/execute", bodyLimit({ maxSize: 32_000 }), async c => {
    const request = z.object({ session_id: z.string().min(1), input: ToolInput }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ ok: false, reason: "invalid_tool_input" }, 400);
    try {
      return c.json({ ok: true, result: await service.execute(request.data.session_id, request.data.input) });
    } catch (error) { return c.json(failure(error), 409); }
  });
  return app;
}
