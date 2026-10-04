import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { ConsultationSafetyService } from "../consultation/safety-service.js";

export function consultationSafetyRouter(service: ConsultationSafetyService, active: (id: string) => boolean): Hono {
  const app = new Hono();
  app.post("/check", bodyLimit({ maxSize: 100_000 }), async c => {
    const body = z.object({ session_id: z.string().min(1), phase: z.enum(["prompt", "tool", "output"]),
      text: z.string().max(50_000), tool: z.string().max(100).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_safety_request", blocked: true }, 400);
    if (!active(body.data.session_id)) return c.json({ error: "active_session_required", blocked: true }, 404);
    const result = await service.check({ sessionId: body.data.session_id, phase: body.data.phase, text: body.data.text, tool: body.data.tool });
    return c.json(result);
  });
  return app;
}
