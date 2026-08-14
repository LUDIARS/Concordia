/**
 * /v1/harness-rules API。 子会社ガードが参照する共通ハーネスルールの CRUD。
 * loopback 信頼境界 (token 不要)。 spec/feature/subsidiary-delegation.md §2.2 / §5。
 *
 * builtin ルールは無効化 (enabled=0) は可能だが削除はできない。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { HarnessRulesRepo, HarnessRuleRow } from "../db/harness-rules-repo.js";

const CreateSchema = z.object({
  kind: z.enum(["allow", "block"]),
  title: z.string().max(120).optional(),
  description: z.string().min(1).max(8000),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  // チームスコープ (spec/feature/teams.md §3.2)。 省略 = グローバルルール。
  team_id: z.string().trim().min(1).max(200).nullable().optional(),
});

const PatchSchema = z.object({
  kind: z.enum(["allow", "block"]).optional(),
  title: z.string().max(120).optional(),
  description: z.string().min(1).max(8000).optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

export interface HarnessRulesApiDeps {
  repo: HarnessRulesRepo;
}

export function harnessRulesRouter(deps: HarnessRulesApiDeps): Hono {
  const app = new Hono();

  const serialize = (r: HarnessRuleRow) => ({ ...r, enabled: r.enabled === 1, builtin: r.builtin === 1 });

  app.get("/", (c) => {
    const all = c.req.query("all") === "1";
    const teamId = (c.req.query("team_id") ?? "").trim();
    return c.json({
      rules: deps.repo.list({ includeDisabled: all, teamId: teamId || undefined }).map(serialize),
    });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    // ダッシュボード追加は常に非 builtin (builtin は seed 専用)。
    const row = deps.repo.create({ ...parsed.data, builtin: false });
    return c.json({ rule: serialize(row) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const row = deps.repo.update(id, parsed.data);
    return c.json({ rule: row ? serialize(row) : null });
  });

  app.delete("/:id", (c) => {
    const r = deps.repo.remove(c.req.param("id"));
    if (!r.ok) {
      const status = r.reason === "not_found" ? 404 : 409;
      return c.json({ error: r.reason }, status);
    }
    return c.json({ ok: true });
  });

  return app;
}
