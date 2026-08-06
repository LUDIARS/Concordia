import { Hono } from "hono";
import { z } from "zod";
import type { ImplementationToolsService } from "../implementation-tools/service.js";

const SessionSchema = z.object({ session_id: z.string().min(1) });
const BindSchema = SessionSchema.extend({ cwd: z.string().min(1), task: z.string().min(1).max(1_000) });
const ServiceSchema = SessionSchema.extend({
  service_code: z.string().min(1).max(64),
  action: z.enum(["start", "stop", "restart"]),
  note: z.string().max(500).optional(),
});

export function implementationToolsRouter(deps: { tools: ImplementationToolsService }): Hono {
  const app = new Hono();
  app.post("/bind", async (c) => {
    const parsed = BindSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      return c.json(await deps.tools.bind({
        sessionId: parsed.data.session_id,
        cwd: parsed.data.cwd,
        task: parsed.data.task,
      }));
    } catch {
      return c.json({ error: "implementation_bind_failed" }, 409);
    }
  });
  app.post("/service", async (c) => {
    const parsed = ServiceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      return c.json(await deps.tools.controlService({
        sessionId: parsed.data.session_id,
        serviceCode: parsed.data.service_code,
        action: parsed.data.action,
        note: parsed.data.note,
      }));
    } catch {
      return c.json({ error: "implementation_service_failed" }, 409);
    }
  });
  app.post("/review", async (c) => {
    const parsed = SessionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      const result = await deps.tools.submitReview(parsed.data.session_id);
      if (!result.submitted && !("resubmitted" in result) && result.reason === "error") {
        return c.json({ submitted: false, reason: "error" });
      }
      return c.json(result);
    } catch {
      return c.json({ error: "implementation_review_failed" }, 409);
    }
  });
  return app;
}
