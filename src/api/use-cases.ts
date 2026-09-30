/**
 * /v1/use-cases — ユースケースの一覧・作成・更新・廃止・削除と、 人の訂正の管理。
 * /v1/sessions/:id/corrections — セッションから訂正を登録する (Discord `/co-correct`)。
 *
 * 入力の形式検証と応答の整形だけを持ち、 業務の検証と永続化はユースケース層へ委ねる。
 * loopback の管理 UI と同じ信頼境界。
 *
 * @implements spec/feature/dialogue-context.md §3 / §6
 * @implements SPEC-DLG-USE-CASES
 * @implements SPEC-DLG-CORRECTIONS
 */

import { Hono } from "hono";
import { z } from "zod";
import type { UseCaseCorrectionsRepo } from "../db/use-case-corrections-repo.js";
import type { UseCaseRow, UseCasesRepo } from "../db/use-cases-repo.js";
import { registerSessionCorrection, type CorrectionLookupPort } from "../dialogue/correction-service.js";
import { USE_CASE_FORMAT_KEYS, USE_CASE_FORMATS } from "../dialogue/formats.js";
import type { UseCaseService, UseCaseServiceResult } from "../dialogue/use-case-service.js";

const SlugSchema = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const WorkModeSchema = z.enum(["edit", "read-only"]);

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: SlugSchema,
  format: z.enum(USE_CASE_FORMAT_KEYS),
  summary: z.string().max(2_000).optional(),
  work_mode: WorkModeSchema.optional(),
  pre_data: z.string().max(50_000).optional(),
  use_requester_profile: z.boolean().optional(),
  // 事前ヒアリング (tech-consultation.md §3)。 省略時はフォーマットの既定。
  intake_enabled: z.boolean().optional(),
}).strict();

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  slug: SlugSchema.optional(),
  format: z.enum(USE_CASE_FORMAT_KEYS).optional(),
  summary: z.string().max(2_000).optional(),
  work_mode: WorkModeSchema.optional(),
  pre_data: z.string().max(50_000).optional(),
  use_requester_profile: z.boolean().optional(),
  // 事前ヒアリング (tech-consultation.md §3)。 省略時はフォーマットの既定。
  intake_enabled: z.boolean().optional(),
}).strict();

const CorrectionCreateSchema = z.object({
  subsidiary_id: z.string().trim().min(1).max(120).nullable().optional(),
  question: z.string().max(4_000).default(""),
  correction: z.string().trim().min(1).max(8_000),
  author: z.string().max(200).default(""),
}).strict();

const CorrectionPatchSchema = z.object({
  question: z.string().max(4_000).optional(),
  correction: z.string().trim().min(1).max(8_000).optional(),
  active: z.boolean().optional(),
}).strict();

const SessionCorrectionSchema = z.object({
  question: z.string().max(4_000).default(""),
  correction: z.string().trim().min(1).max(8_000),
  author: z.string().max(200).default(""),
  source: z.enum(["discord", "api"]).default("api"),
}).strict();

export interface UseCasesApiDeps {
  repo: UseCasesRepo;
  service: UseCaseService;
  corrections: UseCaseCorrectionsRepo;
}

export function useCasesRouter(deps: UseCasesApiDeps): Hono {
  const app = new Hono();

  app.get("/formats", (c) => c.json({
    formats: USE_CASE_FORMAT_KEYS.map((key) => USE_CASE_FORMATS[key]),
  }));

  app.get("/", (c) => c.json({
    use_cases: deps.repo.list({ includeArchived: c.req.query("include_archived") === "1" }).map(serializeUseCase),
  }));

  app.get("/:id", (c) => {
    const row = deps.repo.find(c.req.param("id"));
    return row ? c.json({ use_case: serializeUseCase(row) }) : c.json({ error: "use_case_not_found" }, 404);
  });

  app.post("/", async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_use_case", detail: parsed.error.flatten() }, 400);
    return respond(c, deps.service.create(parsed.data), 201);
  });

  app.patch("/:id", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_use_case", detail: parsed.error.flatten() }, 400);
    return respond(c, deps.service.update(c.req.param("id"), parsed.data), 200);
  });

  app.post("/:id/archive", (c) => respond(c, deps.service.setArchived(c.req.param("id"), true), 200));
  app.post("/:id/restore", (c) => respond(c, deps.service.setArchived(c.req.param("id"), false), 200));

  app.delete("/:id", (c) => {
    const result = deps.service.delete(c.req.param("id"));
    if (result.ok) return c.json({ ok: true });
    const { ok: _ok, ...error } = result;
    return c.json(error, result.error === "use_case_not_found" ? 404 : 409);
  });

  app.get("/:id/corrections", (c) => {
    if (!deps.repo.find(c.req.param("id"))) return c.json({ error: "use_case_not_found" }, 404);
    // subsidiary_id 未指定は全会社 (管理画面)。 "hq" は本社だけ。
    const scope = c.req.query("subsidiary_id");
    const subsidiaryId = scope === undefined ? undefined : scope === "hq" ? null : scope;
    return c.json({
      corrections: deps.corrections.list(c.req.param("id"), {
        subsidiaryId,
        includeInactive: c.req.query("include_inactive") === "1",
      }),
    });
  });

  app.post("/:id/corrections", async (c) => {
    const useCase = deps.repo.find(c.req.param("id"));
    if (!useCase) return c.json({ error: "use_case_not_found" }, 404);
    const parsed = CorrectionCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_correction", detail: parsed.error.flatten() }, 400);
    const correction = deps.corrections.create({
      use_case_id: useCase.id,
      subsidiary_id: parsed.data.subsidiary_id ?? null,
      department_id: null,
      session_id: null,
      source: "webui",
      question: parsed.data.question.trim(),
      correction: parsed.data.correction,
      author: parsed.data.author.trim(),
    });
    return c.json({ correction }, 201);
  });

  app.patch("/:id/corrections/:correctionId", async (c) => {
    const current = deps.corrections.find(c.req.param("correctionId"));
    if (!current || current.use_case_id !== c.req.param("id")) return c.json({ error: "correction_not_found" }, 404);
    const parsed = CorrectionPatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_correction", detail: parsed.error.flatten() }, 400);
    return c.json({ correction: deps.corrections.patch(current.id, parsed.data) });
  });

  app.delete("/:id/corrections/:correctionId", (c) => {
    const current = deps.corrections.find(c.req.param("correctionId"));
    if (!current || current.use_case_id !== c.req.param("id")) return c.json({ error: "correction_not_found" }, 404);
    deps.corrections.delete(current.id);
    return c.json({ ok: true });
  });

  return app;
}

/** /v1/sessions/:id/corrections — セッションの部署のユースケースへ訂正を登録する。 */
export function sessionCorrectionsRouter(deps: {
  lookup: CorrectionLookupPort;
  corrections: UseCaseCorrectionsRepo;
}): Hono {
  const app = new Hono();
  app.post("/:id/corrections", async (c) => {
    const parsed = SessionCorrectionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_correction", detail: parsed.error.flatten() }, 400);
    const result = registerSessionCorrection({ lookup: deps.lookup, store: deps.corrections }, {
      sessionId: c.req.param("id"),
      ...parsed.data,
    });
    if (result.ok) return c.json({ correction: result.correction }, 201);
    return c.json({ error: result.error }, result.error === "session_not_found" ? 404 : 409);
  });
  return app;
}

export function serializeUseCase(row: UseCaseRow) {
  return {
    ...row,
    use_requester_profile: row.use_requester_profile === 1,
    intake_enabled: row.intake_enabled === 1,
    archived: row.archived_at !== null,
    format_name: USE_CASE_FORMATS[row.format]?.name ?? row.format,
  };
}

function respond(
  c: { json: (body: unknown, status: 200 | 201 | 404 | 409) => Response },
  result: UseCaseServiceResult,
  okStatus: 200 | 201,
): Response {
  if (result.ok) return c.json({ use_case: serializeUseCase(result.useCase) }, okStatus);
  const { ok: _ok, ...error } = result;
  return c.json(error, result.error === "use_case_not_found" ? 404 : 409);
}
