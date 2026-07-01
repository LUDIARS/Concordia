/**
 * /v1/model-catalog API — delegation テンプレ / spawn が選べるモデル候補の CRUD。
 *
 * Concordia は loopback (既定 127.0.0.1:11111) 限定で動くので bearer token は要求しない
 * (delegation CRUD と同じ信頼境界)。 spec/delegation.md §6。
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  MODEL_PROVIDERS,
  type ModelCatalogRepo,
  type ModelProvider,
} from "../db/model-catalog-repo.js";

const ProviderEnum = z.enum(
  MODEL_PROVIDERS as unknown as [ModelProvider, ...ModelProvider[]],
);

const CreateSchema = z.object({
  model_id: z.string().min(1).max(120),
  label: z.string().max(120).optional(),
  provider: ProviderEnum.optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

const PatchSchema = z.object({
  model_id: z.string().min(1).max(120).optional(),
  label: z.string().max(120).optional(),
  provider: ProviderEnum.optional(),
  sort_order: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

export interface ModelCatalogApiDeps {
  repo: ModelCatalogRepo;
}

export function modelCatalogRouter(deps: ModelCatalogApiDeps): Hono {
  const app = new Hono();

  function serialize(row: ReturnType<ModelCatalogRepo["find"]>) {
    if (!row) return row;
    return { ...row, is_active: row.is_active === 1 };
  }

  // GET: 既定は active のみ。 ?all=1 で inactive 含む (管理 UI 用)。
  app.get("/", (c) => {
    const includeInactive = c.req.query("all") === "1";
    const rows = deps.repo.list({ includeInactive });
    return c.json({ models: rows.map(serialize) });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      const row = deps.repo.create(parsed.data);
      return c.json({ model: serialize(row) }, 201);
    } catch (err) {
      // UNIQUE(provider, model_id) 違反など
      return c.json({ error: "create_failed", detail: (err as Error).message }, 409);
    }
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    try {
      const row = deps.repo.update(id, parsed.data);
      return c.json({ model: serialize(row) });
    } catch (err) {
      return c.json({ error: "update_failed", detail: (err as Error).message }, 409);
    }
  });

  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    const ok = deps.repo.remove(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
