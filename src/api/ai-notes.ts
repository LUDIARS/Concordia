import { Hono } from "hono";
import { ArticleSchema, ConfirmAbsentSchema, PageIdSchema, ReconcileSchema, TargetKeySchema, TargetsSchema } from "../ai-notes/contract.js";
import { composeNotice } from "../ai-notes/model.js";
import { PublicationError, type PublicationService } from "../ai-notes/publication-service.js";

/** Session/admin surface under Cc's existing local API trust boundary. */
export function aiNotesRouter(service: PublicationService): Hono {
  const app = new Hono();
  app.onError((error, c) => error instanceof PublicationError
    ? c.json({ error: error.code }, error.code === "not_found" ? 404 : 409)
    : c.json({ error: "ai_note_publication_unavailable" }, 503));
  app.get("/targets", c => c.json({ targets: service.store.targets() }));
  app.put("/targets", async c => {
    const parsed = TargetsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_targets", detail: parsed.error.flatten() }, 400);
    service.store.replaceTargets(parsed.data.targets);
    return c.json({ targets: service.store.targets() });
  });
  app.post("/preview", async c => {
    const parsed = ArticleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_article", detail: parsed.error.flatten() }, 400);
    return c.json({ article: parsed.data, content: composeNotice(parsed.data), targets: service.store.targets() });
  });
  app.post("/publications", async c => {
    const parsed = ArticleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_article", detail: parsed.error.flatten() }, 400);
    const publications = await service.publish(parsed.data);
    return c.json({ ok: publications.every(row => row.status === "sent"), publications });
  });
  app.get("/publications/:page_id", c => {
    const parsed = PageIdSchema.safeParse(c.req.param("page_id"));
    if (!parsed.success) return c.json({ error: "invalid_page_id" }, 400);
    return c.json({ publications: service.list(parsed.data) });
  });
  app.post("/publications/:page_id/retry", async c => {
    const page = PageIdSchema.safeParse(c.req.param("page_id"));
    const parsed = TargetKeySchema.safeParse(await c.req.json().catch(() => null));
    if (!page.success || !parsed.success) return c.json({ error: "invalid_request" }, 400);
    return c.json({ publication: await service.retry(page.data, parsed.data.target_key) });
  });
  app.post("/publications/:page_id/reconcile", async c => {
    const page = PageIdSchema.safeParse(c.req.param("page_id"));
    const parsed = ReconcileSchema.safeParse(await c.req.json().catch(() => null));
    if (!page.success || !parsed.success) return c.json({ error: "invalid_request" }, 400);
    return c.json({ publication: await service.reconcile(page.data, parsed.data.target_key, parsed.data.message_id, parsed.data.channel_id) });
  });
  app.post("/publications/:page_id/confirm-absent", async c => {
    const page = PageIdSchema.safeParse(c.req.param("page_id"));
    const parsed = ConfirmAbsentSchema.safeParse(await c.req.json().catch(() => null));
    if (!page.success || !parsed.success) return c.json({ error: "invalid_request" }, 400);
    return c.json({ publication: service.confirmAbsent(page.data, parsed.data.target_key, parsed.data.reason) });
  });
  return app;
}
