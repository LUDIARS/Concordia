/**
 * ユーザー / チームの月次トークン上限予算 API (spec/feature/usage-budgets.md §6)。 loopback 限定の管理 API。
 *
 *   GET    /v1/usage-budgets                          予算の一覧と今月の消費・残り
 *   PUT    /v1/usage-budgets/:scope/:targetId         予算を設定する ({ limit_tokens, updated_by? })
 *   DELETE /v1/usage-budgets/:scope/:targetId         予算を外す (無制限に戻す)
 *   GET    /v1/usage-budgets/check?team=&user=        起動前に、 消費する予算に残りがあるか
 *
 * @implements SPEC-USAGE-BUDGET-API
 */

import { Hono } from "hono";
import { z } from "zod";
import type { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import { budgetNoticeText, evaluateBudget } from "../cost/usage-budget.js";
import { subjectKey, type UsageBudgetTracker } from "../cost/usage-budget-tracker.js";

const ScopeSchema = z.enum(["user", "team"]);
const TargetSchema = z.string().trim().min(1).max(200);
const PutSchema = z.object({
  limit_tokens: z.number().int().min(0).max(1_000_000_000_000),
  updated_by: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

export interface UsageBudgetsApiDeps {
  budgets: UsageBudgetsRepo;
  tracker: UsageBudgetTracker;
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
    return c.json({ budget });
  });

  app.delete("/:scope/:targetId", (c) => {
    const scope = ScopeSchema.safeParse(c.req.param("scope"));
    const target = TargetSchema.safeParse(c.req.param("targetId"));
    if (!scope.success || !target.success) return c.json({ error: "invalid_budget" }, 400);
    return c.json({ removed: deps.budgets.remove(scope.data, target.data) });
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
