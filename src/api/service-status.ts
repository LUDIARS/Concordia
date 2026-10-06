import { Hono } from "hono";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { projectStatus, statusCandidates, type StatusSnapshot } from "../service-status/policy.js";
import { SelectionSchema, headquartersStatusSettings } from "../service-status/settings.js";
import type { ServiceVisibilityPolicy } from "../service-status/visibility.js";

/** @implements CC-SS-02 CC-SS-03 — headquarters loopback management, never a remote mesh listener. */
export function serviceStatusRouter(deps: {
  config: DiscordConfigRepo;
  exists: (id: string) => boolean;
  read: () => Promise<StatusSnapshot>;
  visibility?: ServiceVisibilityPolicy;
}) {
  const app = new Hono();
  app.get("/", async (c) => {
    try { return c.json(projectStatus(await deps.read(), null, Date.now(), deps.visibility)); }
    catch { return c.json({ error: "service_status_unavailable" }, 503); }
  });
  app.use("/subsidiaries/:id/*", async (c, next) => {
    if (!deps.exists(c.req.param("id")!)) return c.json({ error: "subsidiary_not_found" }, 404);
    await next();
  });
  app.get("/subsidiaries/:id/settings", async (c) => {
    const selection = headquartersStatusSettings(deps.config, c.req.param("id")).get();
    return c.json({ selection });
  });
  app.get("/subsidiaries/:id/candidates", async (c) => {
    try {
      const selection = headquartersStatusSettings(deps.config, c.req.param("id")).get();
      const requestedSites = c.req.queries("site");
      const sites = c.req.query("selection") === "explicit" ? requestedSites ?? [] : requestedSites ?? selection.sites;
      if (!SelectionSchema.shape.sites.safeParse(sites).success) return c.json({ error: "invalid_status_selection" }, 400);
      const candidates = statusCandidates(await deps.read(), sites, deps.visibility);
      if (sites.some((site) => !candidates.sites.some((candidate) => candidate.id === site))) return c.json({ error: "invalid_status_selection" }, 400);
      return c.json(candidates);
    } catch { return c.json({ error: "service_status_unavailable" }, 503); }
  });
  app.put("/subsidiaries/:id/settings", async (c) => {
    const parsed = SelectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_status_selection" }, 400);
    try {
      const candidates = statusCandidates(await deps.read(), parsed.data.sites, deps.visibility);
      if (parsed.data.sites.some((id) => !candidates.sites.some((site) => site.id === id))
        || parsed.data.services.some((key) => !candidates.services.some((service) => service.key === key))) {
        return c.json({ error: "invalid_status_selection" }, 400);
      }
      const settings = headquartersStatusSettings(deps.config, c.req.param("id"));
      settings.set(parsed.data);
      return c.json({ selection: settings.get() });
    } catch { return c.json({ error: "service_status_unavailable" }, 503); }
  });
  app.get("/subsidiaries/:id/status", async (c) => {
    try {
      return c.json(projectStatus(
        await deps.read(),
        headquartersStatusSettings(deps.config, c.req.param("id")).get(),
        Date.now(),
        deps.visibility,
      ));
    } catch { return c.json({ error: "service_status_unavailable" }, 503); }
  });
  return app;
}
