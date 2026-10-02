/**
 * ユーザー / チームの月次トークン上限予算 API (spec/feature/usage-budgets.md §6)。 loopback 限定の管理 API。
 *
 *   GET    /v1/usage-budgets                          予算の一覧と今月の消費 (倍率込み)・残り
 *   PUT    /v1/usage-budgets/:scope/:targetId         予算を設定する ({ limit_tokens, updated_by? })
 *   DELETE /v1/usage-budgets/:scope/:targetId         予算を外す (無制限に戻す)
 *   GET    /v1/usage-budgets/check?team=&user=        起動前に、 消費する予算に残りがあるか
 *   GET    /v1/usage-budgets/role-multipliers         属性 (社員名簿の役職) ごとのコスト倍率
 *   PUT    /v1/usage-budgets/role-multipliers/:role   倍率を設定する ({ multiplier, updated_by? })
 *   DELETE /v1/usage-budgets/role-multipliers/:role   倍率を外す (1 に戻す)
 *   GET    /v1/usage-budgets/suspensions              予算切れで中断したセッション
 *   POST   /v1/usage-budgets/suspensions/:sessionId/resume  中断したセッションを再開する ({ actor_user_id })
 *
 * @implements SPEC-USAGE-BUDGET-API
 */

import { Hono } from "hono";
import { z } from "zod";
import type { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import type { UsageBudgetMultipliersRepo } from "../db/usage-budget-multipliers-repo.js";
import { budgetNoticeText, evaluateBudget } from "../cost/usage-budget.js";
import { subjectKey, type UsageBudgetTracker } from "../cost/usage-budget-tracker.js";
import { MAX_COST_MULTIPLIER } from "../cost/budget-multiplier.js";
import type { BudgetResumeResult } from "../cost/budget-resume.js";
import { isSuspended, readSuspension } from "../cost/budget-suspension.js";
import type { SessionRow } from "../shared/types.js";
import { STAFF_ROLES } from "../staff/roles.js";

const ScopeSchema = z.enum(["user", "team"]);
const TargetSchema = z.string().trim().min(1).max(200);
const PutSchema = z.object({
  limit_tokens: z.number().int().min(0).max(1_000_000_000_000),
  updated_by: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const RoleSchema = z.enum(STAFF_ROLES as unknown as ["staff", "manager", "executive"]);
const MultiplierPutSchema = z.object({
  multiplier: z.number().gt(0).max(MAX_COST_MULTIPLIER),
  updated_by: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const ResumeSchema = z.object({
  actor_user_id: z.string().trim().regex(/^\d{5,32}$/),
}).strict();

export interface UsageBudgetsApiDeps {
  budgets: UsageBudgetsRepo;
  tracker: UsageBudgetTracker;
  /** 属性ごとの倍率。 未注入なら倍率の API は無い。 */
  multipliers?: UsageBudgetMultipliersRepo;
  /** 中断の記録を持つセッション。 未注入なら中断の API は無い。 */
  listSuspended?: () => SessionRow[];
  /** 中断したセッションの再開。 未注入なら再開の API は無い。 */
  resume?: (sessionId: string, actorUserId: string) => Promise<BudgetResumeResult>;
}

export function usageBudgetsRouter(deps: UsageBudgetsApiDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const consumption = await deps.tracker.monthlyConsumption();
    return c.json({
      budgets: deps.budgets.list().map((budget) => {
        const consumed = consumption.get(subjectKey({ scope: budget.scope, targetId: budget.target_id })) ?? 0;
        return { ...budget, ...toEvaluationJson(evaluateBudget(consumed, budget.limit_tokens)) };
      }),
    });
  });

  app.get("/check", async (c) => {
    const team = c.req.query("team")?.trim() || null;
    const user = c.req.query("user")?.trim() || null;
    const result = await deps.tracker.checkLaunch({ teamId: team, requesterUserId: user });
    return c.json({
      allowed: result.allowed,
      subject: result.subject,
      ...(result.evaluation ? toEvaluationJson(result.evaluation) : {}),
      ...(result.subject && result.evaluation && !result.allowed
        ? { notice: budgetNoticeText(result.subject, result.evaluation) }
        : {}),
    });
  });

  // 「/:scope/:targetId」より先に登録する (Hono は登録順に照合する)。
  if (deps.multipliers) {
    const multipliers = deps.multipliers;
    app.get("/role-multipliers", (c) => c.json({ multipliers: multipliers.list() }));
    app.put("/role-multipliers/:role", async (c) => {
      const role = RoleSchema.safeParse(c.req.param("role"));
      const body = MultiplierPutSchema.safeParse(await c.req.json().catch(() => null));
      if (!role.success || !body.success) return c.json({ error: "invalid_multiplier" }, 400);
      const multiplier = multipliers.upsert({ role: role.data, multiplier: body.data.multiplier, updated_by: body.data.updated_by ?? null });
      deps.tracker.invalidate();
      return c.json({ multiplier });
    });
    app.delete("/role-multipliers/:role", (c) => {
      const role = RoleSchema.safeParse(c.req.param("role"));
      if (!role.success) return c.json({ error: "invalid_multiplier" }, 400);
      const removed = multipliers.remove(role.data);
      deps.tracker.invalidate();
      return c.json({ removed });
    });
  }

  if (deps.listSuspended) {
    const listSuspended = deps.listSuspended;
    app.get("/suspensions", (c) => c.json({
      suspensions: listSuspended().flatMap((session) => {
        const suspension = readSuspension(session.metadata);
        return isSuspended(suspension) ? [{ session_id: session.id, ...suspension }] : [];
      }),
    }));
  }

  if (deps.resume) {
    const resume = deps.resume;
    app.post("/suspensions/:sessionId/resume", async (c) => {
      const body = ResumeSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid_resume" }, 400);
      const result = await resume(c.req.param("sessionId"), body.data.actor_user_id);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      return c.json({ ok: true, pid: result.pid });
    });
  }

  app.put("/:scope/:targetId", async (c) => {
    const scope = ScopeSchema.safeParse(c.req.param("scope"));
    const target = TargetSchema.safeParse(c.req.param("targetId"));
    const body = PutSchema.safeParse(await c.req.json().catch(() => null));
    if (!scope.success || !target.success || !body.success) return c.json({ error: "invalid_budget" }, 400);
    const budget = deps.budgets.upsert({
      scope: scope.data,
      target_id: target.data,
      limit_tokens: body.data.limit_tokens,
      updated_by: body.data.updated_by ?? null,
    });
    deps.tracker.invalidate();
    return c.json({ budget });
  });

  app.delete("/:scope/:targetId", (c) => {
    const scope = ScopeSchema.safeParse(c.req.param("scope"));
    const target = TargetSchema.safeParse(c.req.param("targetId"));
    if (!scope.success || !target.success) return c.json({ error: "invalid_budget" }, 400);
    const removed = deps.budgets.remove(scope.data, target.data);
    deps.tracker.invalidate();
    return c.json({ removed });
  });

  return app;
}

function toEvaluationJson(evaluation: ReturnType<typeof evaluateBudget>) {
  return {
    consumed_tokens: evaluation.consumedTokens,
    limit_tokens: evaluation.limitTokens,
    ratio: evaluation.ratio,
    exhausted: evaluation.exhausted,
  };
}
