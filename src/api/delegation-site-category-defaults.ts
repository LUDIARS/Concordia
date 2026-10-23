/**
 * 拠点ごとのパートタイマー設定 API (spec/feature/delegation.md §2.3)。
 *
 * - 拠点の category 既定 (未設定なら組み込み既定: parttimer はオフ)
 * - テンプレ別の例外 = 既存の site override の `patch.is_active` (他の patch キーは保つ)
 *
 * @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS
 */
import { Hono } from "hono";
import { z } from "zod";
import type { DelegationCategory, DelegationRepo, DelegationTemplateRow } from "../db/delegation-repo.js";
import { DELEGATION_CATEGORIES } from "../db/delegation-repo.js";
import { siteCategoryDefault } from "../delegation/category-defaults.js";
import { resolveTemplateForScope } from "../delegation/template-overrides.js";

const SiteKey = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u);
const Category = z.enum(DELEGATION_CATEGORIES as unknown as [DelegationCategory, ...DelegationCategory[]]);
const DefaultBody = z.object({ is_active: z.boolean().nullable() }).strict();
const TemplateBody = z.object({ enabled: z.boolean().nullable() }).strict();

export interface SiteCategoryDefaultsDeps {
  repo: DelegationRepo;
  /** テンプレ設定が変わったことをキャッシュと購読者へ伝える。 */
  onTemplateChanged: (row: DelegationTemplateRow | null) => void;
}

/** @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS */
export function siteCategoryDefaultsRouter(deps: SiteCategoryDefaultsDeps): Hono {
  const app = new Hono();

  /** 拠点のその category のテンプレ一覧と、既定・例外・実効の状態。 */
  app.get("/:site/:category", (c) => {
    const site = SiteKey.safeParse(c.req.param("site"));
    const category = Category.safeParse(c.req.param("category"));
    if (!site.success || !category.success) return c.json({ error: "invalid_scope" }, 400);
    const defaults = deps.repo.listCategoryDefaults();
    const configured = defaults.find((row) => row.scope_key === site.data && row.category === category.data);
    const templates = deps.repo.listTemplates({ includeInactive: true })
      .filter((row) => row.category === category.data)
      .map((row) => {
        const overrides = deps.repo.listTemplateOverrides(row.id);
        const exception = readSiteException(overrides.find((item) => item.scope_kind === "site" && item.scope_key === site.data)?.patch_json);
        const resolved = resolveTemplateForScope(row, overrides, { platform: null, siteId: site.data }, defaults);
        return { id: row.id, call_name: row.call_name, title: row.title, template_active: row.is_active === 1, exception, effective_active: resolved.is_active === 1 };
      });
    return c.json({
      site: site.data,
      category: category.data,
      default_active: siteCategoryDefault(category.data, site.data, defaults) ?? true,
      default_configured: Boolean(configured),
      templates,
    });
  });

  /** 拠点の category 既定を設定する。 null で組み込み既定へ戻す。 */
  app.put("/:site/:category", async (c) => {
    const site = SiteKey.safeParse(c.req.param("site"));
    const category = Category.safeParse(c.req.param("category"));
    const body = DefaultBody.safeParse(await c.req.json().catch(() => null));
    if (!site.success || !category.success || !body.success) return c.json({ error: "invalid_body" }, 400);
    if (body.data.is_active === null) deps.repo.deleteCategoryDefault(site.data, category.data);
    else deps.repo.upsertCategoryDefault({ scope_key: site.data, category: category.data, is_active: body.data.is_active });
    deps.onTemplateChanged(null);
    return c.json({ ok: true });
  });

  /** テンプレ別の例外 (この拠点でオン/オフ)。 null で例外を外して既定に従う。 */
  app.put("/:site/:category/templates/:identifier", async (c) => {
    const site = SiteKey.safeParse(c.req.param("site"));
    const body = TemplateBody.safeParse(await c.req.json().catch(() => null));
    if (!site.success || !body.success) return c.json({ error: "invalid_body" }, 400);
    const id = c.req.param("identifier");
    const template = deps.repo.findTemplate(id) ?? deps.repo.findTemplateByCallName(id);
    if (!template) return c.json({ error: "not_found" }, 404);
    const current = deps.repo.listTemplateOverrides(template.id)
      .find((item) => item.scope_kind === "site" && item.scope_key === site.data);
    const patch = parsePatchObject(current?.patch_json);
    if (body.data.enabled === null) delete patch.is_active;
    else patch.is_active = body.data.enabled ? 1 : 0;
    if (Object.keys(patch).length === 0) {
      if (current) deps.repo.deleteTemplateOverride(current.id);
    } else {
      deps.repo.upsertTemplateOverride({ template_id: template.id, scope_kind: "site", scope_key: site.data, patch_json: JSON.stringify(patch), is_active: true });
    }
    deps.onTemplateChanged(template);
    return c.json({ ok: true });
  });

  return app;
}

/** site override の patch から例外 (is_active) だけを読む。 無ければ null。 @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS */
function readSiteException(patchJson: string | undefined): boolean | null {
  const value = parsePatchObject(patchJson).is_active;
  if (value === undefined) return null;
  return value === 1 || value === true;
}

/** @implements SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS */
function parsePatchObject(patchJson: string | undefined): Record<string, unknown> {
  if (!patchJson) return {};
  try {
    const parsed: unknown = JSON.parse(patchJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}
