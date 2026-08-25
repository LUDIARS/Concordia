import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  DIRECTOR_DECISION_KINDS,
  DIRECTOR_STEP_KINDS,
  DIRECTOR_STEP_STATUSES,
} from "../director/types.js";
import {
  DirectorNotFoundError,
  DirectorService,
  DirectorTransitionError,
} from "../director/service.js";
import { eventBus } from "../events.js";

/** step 形の正本。case 起案 (steps 要素) と step 追加が同じ形を共有する。 */
const StepSchema = z.object({
  kind: z.enum(DIRECTOR_STEP_KINDS),
  title: z.string().trim().min(1).max(300),
  task_path: z.string().trim().min(1).max(1_000).nullable().optional(),
  delegation_run_id: z.string().trim().min(1).max(200).nullable().optional(),
  local_pr_id: z.string().trim().min(1).max(200).nullable().optional(),
  confirm_run_id: z.string().trim().min(1).max(200).nullable().optional(),
  handoff_note: z.string().trim().min(1).max(4_000).nullable().optional(),
});

const CreateCaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(4_000),
  project: z.string().trim().min(1).max(200),
  session_id: z.string().trim().min(1).max(200).nullable().optional(),
  team_id: z.string().trim().min(1).max(200).nullable().optional(),
  steps: z.array(StepSchema).min(1).max(50),
});

const PatchStepSchema = z.object({
  status: z.enum(DIRECTOR_STEP_STATUSES).optional(),
  handoff_note: z.string().trim().min(1).max(4_000).nullable().optional(),
}).refine((value) => value.status !== undefined || value.handoff_note !== undefined);

/**
 * 既存 case への step 追加 (spec/feature/director-workflow.md §3)。
 * 成果物参照 (run / PR / confirm) は持たせない — pending + run id 付きの step を
 * 作れると巡回の assign ガード (delegation_run_id IS NULL) と矛盾するため。
 */
const AppendStepSchema = StepSchema.omit({
  delegation_run_id: true,
  local_pr_id: true,
  confirm_run_id: true,
});

const DecisionSchema = z.object({
  kind: z.enum(DIRECTOR_DECISION_KINDS),
  question: z.string().trim().min(1).max(4_000),
  facts: z.array(z.string().trim().min(1).max(2_000)).max(30).default([]),
  // Discord の質問カード契約と同じ上限。ここを超えると表示と
  // decision への index マッピングが一致しなくなるため、入口で拒否する。
  // 「2 件以上」は問診指示テンプレート側の努力目標に留める。ここを必須にすると
  // 問診以外の既存呼び出し (選択肢を持たない decision) まで 400 になるため。
  options: z.array(z.string().trim().min(1).max(80)).max(25).default([]),
  impact: z.string().trim().min(1).max(4_000),
});
const PlanSchema = z.object({
  markdown: z.string().min(1).max(100_000),
  md_ref: z.string().max(2_000).nullable().optional(),
});
const PlanActionSchema = z.object({
  action: z.enum(["approve", "revise", "discard"]),
  version: z.number().int().positive(),
  instruction: z.string().trim().min(1).max(8_000).optional(),
}).superRefine((value, ctx) => {
  if (value.action === "revise" && !value.instruction) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["instruction"],
      message: "revision instruction required",
    });
  }
});

export function directorRouter(deps: { service: DirectorService }): Hono {
  const app = new Hono();

  app.post("/cases", async (c) => {
    const parsed = CreateCaseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_case" }, 400);
    return c.json(deps.service.createCase(parsed.data), 201);
  });

  app.get("/cases", (c) => {
    const teamId = (c.req.query("team_id") ?? "").trim();
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    return c.json({ cases: deps.service.listCases({ team_id: teamId || undefined, limit }) });
  });

  app.get("/issue-signals", (c) => {
    const teamId = (c.req.query("team_id") ?? "").trim();
    if (!teamId || teamId.length > 200) {
      return c.json({ error: "invalid_team_id" }, 400);
    }
    const requestedDays = Number(c.req.query("days"));
    const days = Number.isInteger(requestedDays) && requestedDays > 0
      ? Math.min(requestedDays, 90)
      : 30;
    return c.json(deps.service.issueSignals({ team_id: teamId, days }));
  });

  app.get("/cases/:caseId", (c) => {
    const detail = deps.service.getCase(c.req.param("caseId"));
    return detail ? c.json(detail) : c.json({ error: "not_found" }, 404);
  });

  app.post("/cases/:caseId/steps", async (c) => {
    const parsed = AppendStepSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_step" }, 400);
    try {
      return c.json({ step: deps.service.appendStep({
        case_id: c.req.param("caseId"),
        step: parsed.data,
      }) }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch("/cases/:caseId/steps/:stepId", async (c) => {
    const parsed = PatchStepSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_step" }, 400);
    try {
      const ids = { case_id: c.req.param("caseId"), step_id: c.req.param("stepId") };
      let status = parsed.data.status;
      if (status === undefined) {
        const current = deps.service.getCase(ids.case_id)?.steps
          .find((candidate) => candidate.id === ids.step_id);
        if (!current) throw new DirectorNotFoundError("director step not found");
        status = current.status;
      }
      const step = deps.service.updateStep({ ...ids, ...parsed.data, status });
      return c.json({ step });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/cases/:caseId/steps/:stepId/decisions", async (c) => {
    const parsed = DecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_decision" }, 400);
    try {
      return c.json(await deps.service.requestDecision({
        case_id: c.req.param("caseId"),
        step_id: c.req.param("stepId"),
        ...parsed.data,
      }), 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/cases/:caseId/plan", async (c) => {
    const parsed = PlanSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_plan" }, 400);
    try {
      const detail = deps.service.getCase(c.req.param("caseId"));
      const step = detail?.steps.find((candidate) => candidate.kind === "plan");
      if (!step || !detail) return c.json({ error: "plan_step_not_found" }, 404);
      const result = deps.service.submitPlan({ case_id: detail.case.id, step_id: step.id, ...parsed.data });
      if (detail.case.session_id) {
        eventBus.emit({
          type: "director.plan_submitted",
          target_session_id: detail.case.session_id,
          case_id: detail.case.id,
          version: result.decision.plan_version!,
          markdown: parsed.data.markdown,
          ts: Math.floor(Date.now() / 1000),
        });
      }
      return c.json(result, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  app.post("/cases/:caseId/plan/action", async (c) => {
    const parsed = PlanActionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_action" }, 400);
    try {
      const detail = deps.service.getCase(c.req.param("caseId"));
      const step = detail?.steps.find((candidate) => candidate.kind === "plan");
      if (!step || !detail) return c.json({ error: "plan_step_not_found" }, 404);
      return c.json({
        step: deps.service.decidePlan({
          case_id: detail.case.id,
          step_id: step.id,
          ...parsed.data,
        }),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  return app;
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof DirectorNotFoundError) return c.json({ error: "not_found" }, 404);
  if (error instanceof DirectorTransitionError) return c.json({ error: "invalid_transition" }, 409);
  throw error;
}
