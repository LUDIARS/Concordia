/**
 * /v1/subsidiaries API。 子会社 CRUD + 許可 delegation + ロック + Bot ライフサイクル
 * + 監査ログ。 loopback 信頼境界 (token 不要、 他 /v1/admin/* と同様)。
 *
 * token (bot/app) は secret-box で暗号化して保存し、 GET では値を返さず set 済みかだけ。
 * spec/feature/subsidiary-delegation.md §5。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SubsidiaryRepo, SubsidiaryRow } from "../db/subsidiary-repo.js";
import type { SubsidiaryBotManager } from "../subsidiary/manager.js";
import type { SubsidiaryBudgetTracker } from "../subsidiary/budget.js";
import type { SecretBox } from "../shared/secret-box.js";

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const CreateSchema = z.object({
  name: z.string().regex(NAME_RE),
  display_name: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  platform: z.enum(["discord", "slack"]).optional(),
  enabled: z.boolean().optional(),
  guild_id: z.string().max(64).nullable().optional(),
  application_id: z.string().max(64).nullable().optional(),
  channel_id: z.string().max(64).nullable().optional(),
  bot_token: z.string().max(200).nullable().optional(),
  app_token: z.string().max(200).nullable().optional(),
  guard_model: z.string().max(64).optional(),
  guard_scope: z.string().max(8000).optional(),
  home_cwd: z.string().max(1000).nullable().optional(),
  daily_token_budget: z.number().int().min(0).max(1_000_000_000).optional(),
});

const PatchSchema = CreateSchema.partial().omit({ name: true });

const DelegationsSchema = z.object({
  delegations: z.array(z.object({ call_name: z.string().max(64), is_default: z.boolean().optional() })),
});

const LockSchema = z.object({
  platform: z.enum(["discord", "slack"]),
  platform_user_id: z.string().max(64),
  user_label: z.string().max(120).optional(),
  reason: z.string().max(2000).optional(),
});

export interface SubsidiaryApiDeps {
  repo: SubsidiaryRepo;
  manager: SubsidiaryBotManager;
  secretBox: SecretBox;
  /** 子会社の日次トークン予算トラッカー (当日消費を serialize に載せる)。 省略可。 */
  budget?: SubsidiaryBudgetTracker;
}

export function subsidiaryRouter(deps: SubsidiaryApiDeps): Hono {
  const app = new Hono();

  /** token を伏せて返す (set 済みかだけ)。 当日のコスト消費 / 予算 / block も載せる。 */
  function serialize(row: SubsidiaryRow) {
    const { bot_token_enc, app_token_enc, ...rest } = row;
    const usage = deps.budget?.status(row);
    return {
      ...rest,
      enabled: row.enabled === 1,
      bot_token_set: !!bot_token_enc,
      app_token_set: !!app_token_enc,
      running: deps.manager.isRunning(row.id),
      usage_today_tokens: usage?.todayTokens ?? 0,
      budget_blocked: usage?.blocked ?? false,
    };
  }

  /** undefined=据え置き / ""or null=クリア / 値=暗号化保存。 enc 値 (string|null|undefined) を返す。 */
  function encField(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    const v = (value ?? "").trim();
    return v ? deps.secretBox.encrypt(v) : null;
  }

  app.get("/", (c) => {
    const rows = deps.repo.list().map((r) => ({
      ...serialize(r),
      delegations: deps.repo.listDelegations(r.id),
      lock_count: deps.repo.listLocks(r.id).length,
    }));
    return c.json({ subsidiaries: rows });
  });

  app.get("/:id", (c) => {
    const row = deps.repo.find(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      subsidiary: serialize(row),
      delegations: deps.repo.listDelegations(row.id),
      locks: deps.repo.listLocks(row.id),
      requests: deps.repo.recentRequests(row.id, 50),
    });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    if (deps.repo.findByName(parsed.data.name)) return c.json({ error: "name_taken" }, 409);
    const { bot_token, app_token, ...rest } = parsed.data;
    const row = deps.repo.create({
      ...rest,
      bot_token_enc: encField(bot_token) ?? null,
      app_token_enc: encField(app_token) ?? null,
    });
    return c.json({ subsidiary: serialize(row) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const { bot_token, app_token, ...rest } = parsed.data;
    const row = deps.repo.update(id, {
      ...rest,
      bot_token_enc: encField(bot_token),
      app_token_enc: encField(app_token),
    });
    return c.json({ subsidiary: row ? serialize(row) : null });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await deps.manager.stop(id);
    const ok = deps.repo.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.put("/:id/delegations", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = DelegationsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    deps.repo.setDelegations(id, parsed.data.delegations);
    return c.json({ delegations: deps.repo.listDelegations(id) });
  });

  // ── Bot lifecycle ─────────────────────────────────────────
  app.post("/:id/start", async (c) => c.json(await deps.manager.start(c.req.param("id"))));
  app.post("/:id/stop", async (c) => c.json(await deps.manager.stop(c.req.param("id"))));
  app.post("/:id/restart", async (c) => c.json(await deps.manager.restart(c.req.param("id"))));

  // ── requests (監査ログ) ───────────────────────────────────
  app.get("/:id/requests", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const limitRaw = Number(c.req.query("limit") ?? 100);
    const limit = Math.max(1, Math.min(500, isFinite(limitRaw) ? limitRaw : 100));
    return c.json({ requests: deps.repo.recentRequests(id, limit) });
  });

  // ── locks ─────────────────────────────────────────────────
  app.get("/:id/locks", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ locks: deps.repo.listLocks(id) });
  });

  app.post("/:id/locks", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = LockSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    deps.repo.lock({ subsidiary_id: id, ...parsed.data });
    return c.json({ ok: true, locks: deps.repo.listLocks(id) });
  });

  app.delete("/:id/locks/:platform/:userId", (c) => {
    const id = c.req.param("id");
    const ok = deps.repo.unlock(id, c.req.param("platform"), c.req.param("userId"));
    return c.json({ ok });
  });

  return app;
}
