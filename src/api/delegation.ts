/**
 * /v1/delegation API.
 * spec/delegation.md §5.
 */

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  DELEGATION_PROVIDERS,
  type DelegationRepo,
  type DelegationProvider,
} from "../db/delegation-repo.js";
import type { DelegationService } from "../delegation/service.js";

const CALL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const InputSchemaItemSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

// 作成時は call_name / title / prompt_template を空欄でも受け付ける (下書き許容)。
//   - call_name 空/不正 → title からスラッグ化、 無理なら `tpl-<random>` を自動採番。
//   - title 空 → call_name で埋める。
//   - prompt_template 空 → 空文字のまま保存可 (invoke 時に context だけ載る)。
const CreateTemplateSchema = z.object({
  call_name: z.string().max(64).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  target_provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]),
  model: z.string().max(120).nullable().optional(),
  prompt_template: z.string().max(20000).optional(),
  input_schema: z.array(InputSchemaItemSchema).optional(),
  default_cwd: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  emoji: z.string().max(8).optional(),
  call_only: z.boolean().optional(),
});

const PatchTemplateSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  target_provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]).optional(),
  model: z.string().max(120).nullable().optional(),
  prompt_template: z.string().max(20000).optional(),
  input_schema: z.array(InputSchemaItemSchema).optional(),
  default_cwd: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  emoji: z.string().max(8).optional(),
  call_only: z.boolean().optional(),
});

/** title 等を call_name スラッグへ。 [a-z][a-z0-9_-]{0,63} に収まらなければ空文字を返す。 */
function slugifyCallName(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return CALL_NAME_RE.test(s) ? s : "";
}

/** 空/不正な call_name を、 title スラッグ → ランダムの順で一意に解決する。 */
function resolveCallName(repo: DelegationRepo, raw: string | undefined, title: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  let base = CALL_NAME_RE.test(trimmed) ? trimmed : slugifyCallName(title ?? "");
  if (!base) base = `tpl-${randomUUID().slice(0, 8)}`;
  if (!repo.findTemplateByCallName(base)) return base;
  // 衝突時は -2, -3, … を足す (それでも埋まればランダム)。
  for (let i = 2; i <= 50; i++) {
    const cand = `${base}-${i}`.slice(0, 64);
    if (!repo.findTemplateByCallName(cand)) return cand;
  }
  return `tpl-${randomUUID().slice(0, 8)}`;
}

const InvokeSchema = z.object({
  call_name: z.string().regex(CALL_NAME_RE),
  args: z.record(z.unknown()).default({}),
  cwd: z.string().optional(),
  triggered_by: z.string().max(120).optional(),
  spawn: z.boolean().optional(),
});

export interface DelegationApiDeps {
  repo: DelegationRepo;
  service: DelegationService;
}

export function delegationRouter(deps: DelegationApiDeps): Hono {
  const app = new Hono();

  // mutating endpoint は bearer token を要求しない。 Concordia は loopback
  // (既定 127.0.0.1:17330) 限定で動き、 /v1/admin/* と同じ信頼境界に乗る。
  // 以前は spawn token を要求していたが、 同じ loopback サービス内で Monitor の
  // spawn は token-free・Delegation CRUD だけ token 必須という非対称が混乱の元
  // (token 未貼付で Save できない) だったため撤廃。

  function serializeTemplate(row: Awaited<ReturnType<DelegationRepo["findTemplate"]>>) {
    if (!row) return row;
    return {
      ...row,
      input_schema: safeJsonParse(row.input_schema, []),
      is_active: row.is_active === 1,
      call_only: row.call_only === 1,
    };
  }

  function serializeRun(row: Awaited<ReturnType<DelegationRepo["findRun"]>>) {
    if (!row) return row;
    return {
      ...row,
      args: safeJsonParse(row.args_json, {}),
      spawn_command: row.spawn_command ? safeJsonParse(row.spawn_command, []) : null,
    };
  }

  // ── GET endpoints (no auth) ───────────────────────────────
  app.get("/templates", (c) => {
    const rows = deps.repo.listTemplates({ includeInactive: false });
    return c.json({ templates: rows.map(serializeTemplate) });
  });

  app.get("/templates/all", (c) => {
    const rows = deps.repo.listTemplates({ includeInactive: true });
    return c.json({ templates: rows.map(serializeTemplate) });
  });

  app.get("/templates/:identifier", (c) => {
    const id = c.req.param("identifier");
    const row = deps.repo.findTemplate(id) ?? deps.repo.findTemplateByCallName(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ template: serializeTemplate(row) });
  });

  app.get("/runs", (c) => {
    const limitRaw = Number(c.req.query("limit") ?? 100);
    const limit = Math.max(1, Math.min(500, isFinite(limitRaw) ? limitRaw : 100));
    const rows = deps.repo.recentRuns(limit);
    return c.json({ runs: rows.map(serializeRun) });
  });

  // ── Mutating endpoints (bearer auth) ─────────────────────
  app.post("/templates", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTemplateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    // 空欄許容: call_name は自動採番 (title スラッグ → ランダム)、 title 空は call_name で代替、
    // prompt_template 空はそのまま空文字で保存 (invoke 時に context だけ載る)。
    const call_name = resolveCallName(deps.repo, parsed.data.call_name, parsed.data.title);
    const title = (parsed.data.title ?? "").trim() || call_name;
    const row = deps.repo.createTemplate({
      ...parsed.data,
      call_name,
      title,
      prompt_template: parsed.data.prompt_template ?? "",
    });
    return c.json({ template: serializeTemplate(row) }, 201);
  });

  app.patch("/templates/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findTemplate(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchTemplateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const row = deps.repo.updateTemplate(id, parsed.data);
    return c.json({ template: serializeTemplate(row) });
  });

  app.delete("/templates/:id", (c) => {
    const id = c.req.param("id");
    const ok = deps.repo.deactivateTemplate(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/invoke", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = InvokeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const result = await deps.service.invoke({
      call_name: parsed.data.call_name,
      args: parsed.data.args,
      cwd: parsed.data.cwd,
      triggered_by: parsed.data.triggered_by,
      spawn: parsed.data.spawn,
    });
    if (!result.ok) {
      const status = result.error.startsWith("unknown call_name") ? 404 : 400;
      return c.json({ error: result.error, detail: result.details }, status);
    }
    return c.json({
      ok: true,
      run: serializeRun(result.run),
      rendered_prompt: result.rendered_prompt,
      prompt_file_path: result.prompt_file_path,
      spawn_pid: result.spawn_pid,
      spawn_command: result.spawn_command,
    });
  });

  return app;
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
