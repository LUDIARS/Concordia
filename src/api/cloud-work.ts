import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import type { CloudScope, CloudWorkRuntime } from "../cloud-work/runtime-service.js";
import { CloudWorkPlanSchema } from "../cloud-work/runtime-config.js";

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Submit = z.object({ session_id: z.string().min(1).max(200), attemptId: Id, targetId: Id,
  taskReference: z.string().regex(/^actio:[A-Za-z0-9-]+$/), instruction: z.string().trim().min(1).max(12_000),
  computeReason: z.string().trim().min(1).max(1000), llmReason: z.string().trim().min(1).max(1000), gpuRequired: z.boolean(),
  work: CloudWorkPlanSchema.optional(),
}).strict();

/** Shares existing delegation's loopback/admin trust boundary, with task/repo/company scope. */
export function cloudWorkRouter(deps: {
  sessions: Pick<SessionsRepo, "findSession">;
  runtime: CloudWorkRuntime;
  authorizeSubmit?: (sessionId: string, scope: CloudScope) => Promise<void>;
  repositoryKey?: (path: string) => Promise<string>;
}): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 32_000 }));
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, c) => {
    // Only our closed error vocabulary may leave the boundary; SDK/HTTP errors can contain tokens.
    const safe = /^(?:cloud|codex_cloud|invalid_cloud|standard_hosted)_[a-z_]+$/.test(error.message) ? error.message : "cloud_operation_failed";
    return c.json({ error: safe }, 409);
  });
  async function scope(id: string | undefined): Promise<CloudScope | null> {
    if (!id) return null;
    const session = deps.sessions.findSession(id);
    if (!session || !["active", "blocked"].includes(session.status) || !session.repo_path) return null;
    return { repositoryKey: await (deps.repositoryKey ?? mainRepositoryKey)(session.repo_path), subsidiaryId: readSubsidiaryId(session.metadata) };
  }
  app.get("/targets", async c => {
    const owner = await scope(c.req.query("session_id"));
    if (!owner) return c.json({ error: "cloud_active_session_required" }, 403);
    return c.json({ targets: await deps.runtime.availability(owner) });
  });
  app.post("/runs", async c => {
    const parsed = Submit.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_cloud_request" }, 400);
    const owner = await scope(parsed.data.session_id);
    if (!owner) return c.json({ error: "cloud_active_session_required" }, 403);
    await deps.authorizeSubmit?.(parsed.data.session_id, owner);
    return c.json(await deps.runtime.submit(owner, parsed.data), 202);
  });
  app.get("/runs", async c => {
    const owner = await scope(c.req.query("session_id"));
    if (!owner) return c.json({ error: "cloud_active_session_required" }, 403);
    return c.json({ runs: await deps.runtime.list(owner) });
  });
  app.get("/runs/:id", async c => {
    if (!Id.safeParse(c.req.param("id")).success) return c.json({ error: "invalid_cloud_attempt_id" }, 400);
    const owner = await scope(c.req.query("session_id"));
    if (!owner) return c.json({ error: "cloud_active_session_required" }, 403);
    return c.json(await deps.runtime.status(owner, c.req.param("id")));
  });
  for (const action of ["collect", "reconcile"] as const) {
    app.post(`/runs/:id/${action}`, async c => {
      if (!Id.safeParse(c.req.param("id")).success) return c.json({ error: "invalid_cloud_attempt_id" }, 400);
      const schema = z.object({ session_id: z.string().min(1), ...(action === "reconcile" ? { remoteId: Id } : {}) }).strict();
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "invalid_cloud_request" }, 400);
      const owner = await scope(parsed.data.session_id);
      if (!owner) return c.json({ error: "cloud_active_session_required" }, 403);
      return c.json(action === "collect" ? await deps.runtime.collect(owner, c.req.param("id"))
        : await deps.runtime.reconcile(owner, c.req.param("id"), (parsed.data as { remoteId: string }).remoteId));
    });
  }
  app.get("/runs/:id/artifacts/:name", async c => {
    if (!Id.safeParse(c.req.param("id")).success) return c.json({ error: "invalid_cloud_attempt_id" }, 400);
    const owner = await scope(c.req.query("session_id"));
    if (!owner) return c.json({ error: "cloud_active_session_required" }, 403);
    const name = c.req.param("name");
    const data = await deps.runtime.download(owner, c.req.param("id"), name);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${name}"`);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(new Uint8Array(data));
  });
  return app;
}
