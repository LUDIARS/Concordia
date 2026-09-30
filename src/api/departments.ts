/**
 * /v1/departments — 部署の一覧・作成・更新・廃止・復帰。
 *
 * 入力の形式検証と応答の整形だけを持ち、 業務の検証と永続化は DepartmentService へ
 * 委ねる。 loopback の管理 UI と同じ信頼境界 (他の /v1/teams 等と同じ扱い)。
 *
 * @implements spec/feature/departments.md §7
 * @implements SPEC-DEPT-API
 */

import { Hono } from "hono";
import { z } from "zod";
import type { DepartmentRow, DepartmentsRepo } from "../db/departments-repo.js";
import type { DepartmentService, DepartmentServiceResult } from "../departments/service.js";
import { DepartmentSettingsSchema, parseDepartmentSettings, type DepartmentSettings } from "../departments/settings.js";

const SlugSchema = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: SlugSchema,
  subsidiary_id: z.string().trim().min(1).max(120).nullable().optional(),
  description: z.string().max(2_000).default(""),
  settings: DepartmentSettingsSchema.default({}),
  rules_text: z.string().max(50_000).default(""),
  sort_order: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  // 部署のセッションが何をするか (spec/feature/dialogue-context.md)。
  use_case_id: z.string().trim().min(1).max(120).nullable().optional(),
  // 会社の既定部署 (spec/feature/departments.md §9.2)。
  is_default: z.boolean().optional(),
}).strict();

// 所有会社の変更は既存セッションの所属と組織の可視境界を変えるため受け付けない
// (CC-DEPT-INV-01)。 strict で subsidiary_id を含む要求そのものを拒否する。
const PatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  slug: SlugSchema.optional(),
  description: z.string().max(2_000).optional(),
  settings: DepartmentSettingsSchema.optional(),
  rules_text: z.string().max(50_000).optional(),
  sort_order: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  use_case_id: z.string().trim().min(1).max(120).nullable().optional(),
  is_default: z.boolean().optional(),
}).strict();

export interface DepartmentsApiDeps {
  repo: DepartmentsRepo;
  service: DepartmentService;
  /** provider 名の妥当性 (spawner の対応 provider)。 */
  isKnownProvider: (provider: string) => boolean;
  /** 委託テンプレートが存在して有効か。 */
  isActiveTemplate: (callName: string) => boolean;
}

export function departmentsRouter(deps: DepartmentsApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const includeArchived = c.req.query("include_archived") === "1";
    // all_organizations=1 は組織セッション画面用 (本社と全子会社を 1 回で引く)。
    // それ以外は /v1/teams と同じく、 無指定 = 本社、 子会社は明示 query のみ。
    const rows = c.req.query("all_organizations") === "1"
      ? deps.repo.listAll({ includeArchived })
      : deps.repo.listForOrganization(c.req.query("subsidiary_id")?.trim() || null, { includeArchived });
    return c.json({ departments: rows.map(serializeDepartment) });
  });

  app.get("/:id", (c) => {
    const row = deps.repo.find(c.req.param("id"));
    if (!row) return c.json({ error: "department_not_found" }, 404);
    return c.json({ department: serializeDepartment(row) });
  });

  app.post("/", async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_department", detail: parsed.error.flatten() }, 400);
    const launchError = validateLaunch(deps, parsed.data.settings);
    if (launchError) return c.json(launchError, 400);
    return respond(c, deps.service.create({ ...parsed.data, subsidiary_id: parsed.data.subsidiary_id ?? null }), 201);
  });

  app.patch("/:id", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_department", detail: parsed.error.flatten() }, 400);
    if (parsed.data.settings) {
      const launchError = validateLaunch(deps, parsed.data.settings);
      if (launchError) return c.json(launchError, 400);
    }
    return respond(c, deps.service.update(c.req.param("id"), parsed.data), 200);
  });

  app.post("/:id/archive", (c) => respond(c, deps.service.setArchived(c.req.param("id"), true), 200));
  app.post("/:id/restore", (c) => respond(c, deps.service.setArchived(c.req.param("id"), false), 200));

  return app;
}

type DepartmentResponse = Omit<DepartmentRow, "is_default"> & {
  settings: DepartmentSettings | null;
  settings_error: string | null;
  archived: boolean;
  is_default: boolean;
};

export function serializeDepartment(row: DepartmentRow): DepartmentResponse {
  let settings: DepartmentSettings | null = null;
  let settingsError: string | null = null;
  try {
    settings = parseDepartmentSettings(row.settings_json);
  } catch (err) {
    // 一覧を落とさず、 壊れた行だと分かる形で返す (起動側は同じ行を拒否する)。
    settingsError = err instanceof Error ? err.message : String(err);
  }
  return {
    ...row,
    settings,
    settings_error: settingsError,
    archived: row.archived_at !== null,
    is_default: row.is_default === 1,
  };
}

function validateLaunch(deps: DepartmentsApiDeps, settings: DepartmentSettings): { error: string; detail: string } | null {
  const { provider, template } = settings.launch;
  if (provider && !deps.isKnownProvider(provider)) {
    return { error: "invalid_department", detail: `unknown provider: ${provider}` };
  }
  if (template && !deps.isActiveTemplate(template)) {
    return { error: "invalid_department", detail: `unknown or inactive template: ${template}` };
  }
  return null;
}

const ERROR_STATUS: Record<string, 400 | 404 | 409> = {
  subsidiary_not_found: 404,
  department_not_found: 404,
  department_slug_taken: 409,
  department_archived: 409,
  department_projects_outside_subsidiary_scope: 400,
  invalid_department_settings: 400,
  use_case_not_assignable: 400,
};

function respond(
  c: { json: (body: unknown, status: 200 | 201 | 400 | 404 | 409) => Response },
  result: DepartmentServiceResult,
  okStatus: 200 | 201,
): Response {
  if (result.ok) return c.json({ department: serializeDepartment(result.department) }, okStatus);
  const { ok: _ok, ...error } = result;
  return c.json(error, ERROR_STATUS[result.error] ?? 400);
}
