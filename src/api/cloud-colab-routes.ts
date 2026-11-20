import { Hono } from "hono";
import { z } from "zod";
import type { ColabService } from "../cloud-work/colab-service.js";
import type { CloudScope } from "../cloud-work/runtime-service.js";

const SessionId = z.string().min(1).max(200);
const Attempt = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Start = z.object({
  session_id: SessionId, attemptId: Attempt, targetId: Attempt, taskReference: z.string().regex(/^actio:[A-Za-z0-9-]+$/),
  seconds: z.number().int().min(30).max(1800), ownerApproved: z.literal(true),
  evidence: z.object({ code: z.literal("public"), data: z.literal("non_confidential"),
    destination: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).strict(),
}).strict();
const SessionOnly = z.object({ session_id: SessionId }).strict();
const Quality = SessionOnly.extend({ quality: z.enum(["accepted", "rejected"]) });

export function cloudColabRoutes(deps: {
  colab: ColabService;
  scope(id: string | undefined): Promise<CloudScope | null>;
  authorizeSubmit?: (id: string, scope: CloudScope) => Promise<void>;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!c.get("concordiaWebIdentity")) return c.json({ error: "cloud_colab_owner_required" }, 403);
    if (c.req.method === "POST" && c.req.header("sec-fetch-site") !== "same-origin") {
      return c.json({ error: "cloud_colab_owner_required" }, 403);
    }
    await next();
  });
  app.get("/targets", async c => {
    const scope = await deps.scope(c.req.query("session_id"));
    const owner = c.get("concordiaWebIdentity");
    if (!scope || !owner) return c.json({ error: "cloud_colab_owner_required" }, 403);
    return c.json({ targets: await deps.colab.targets(scope, owner) });
  });
  app.get("/runs", async c => {
    const scope = await deps.scope(c.req.query("session_id"));
    const owner = c.get("concordiaWebIdentity");
    if (!scope || !owner) return c.json({ error: "cloud_colab_owner_required" }, 403);
    return c.json({ runs: await deps.colab.list(scope, owner) });
  });
  app.post("/runs", async c => {
    const input = Start.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_cloud_request" }, 400);
    const scope = await deps.scope(input.data.session_id);
    const owner = c.get("concordiaWebIdentity");
    if (!scope || !owner) return c.json({ error: "cloud_colab_owner_required" }, 403);
    await deps.authorizeSubmit?.(input.data.session_id, scope);
    return c.json(await deps.colab.start(scope, owner, input.data), 202);
  });
  for (const action of ["stop", "collect", "quality"] as const) {
    app.post(`/runs/:id/${action}`, async c => {
      const id = Attempt.safeParse(c.req.param("id"));
      const input = (action === "quality" ? Quality : SessionOnly).safeParse(await c.req.json().catch(() => null));
      if (!id.success || !input.success) return c.json({ error: "invalid_cloud_request" }, 400);
      const scope = await deps.scope(input.data.session_id);
      const owner = c.get("concordiaWebIdentity");
      if (!scope || !owner) return c.json({ error: "cloud_colab_owner_required" }, 403);
      const quality = Quality.safeParse(input.data);
      if (action === "collect") return c.json(await deps.colab.collect(scope, owner, id.data));
      if (quality.success) return c.json(await deps.colab.quality(scope, owner, id.data, quality.data.quality));
      return c.json(await deps.colab.stop(scope, owner, id.data));
    });
  }
  return app;
}
