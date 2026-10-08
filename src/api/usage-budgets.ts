/**
 * ユーザー / チームの月次トークン上限予算 API (spec/feature/usage-budgets.md §6)。 loopback 限定の管理 API。
 *
 *   GET    /v1/usage-budgets                          予算の一覧と今月の消費 (倍率込み)・残り
 *   PUT    /v1/usage-budgets/:scope/:targetId         予算を設定する ({ limit_tokens, updated_by? })
 *   DELETE /v1/usage-budgets/:scope/:targetId         予算を外す (無制限に戻す)
 *   GET    /v1/usage-budgets/check?team=&user=        起動前に、 消費する予算に残りがあるか
 *   GET    /v1/usage-budgets/users                    ユーザーごとの今月の消費 (倍率込み。 予算の有無に関係なく、 予算があれば割合も)
 *   GET    /v1/usage-budgets/role-multipliers           属性 (Discord のロール) ごとのコスト倍率
 *   GET    /v1/usage-budgets/discord-roles              倍率を設定できる Discord のロール (guild ごと、 名前つき)
 *   PUT    /v1/usage-budgets/role-multipliers/:roleId   倍率を設定する ({ guild_id, multiplier, updated_by? })
 *   DELETE /v1/usage-budgets/role-multipliers/:roleId   倍率を外す (1 に戻す)
 *   GET    /v1/usage-budgets/suspensions              予算切れで中断したセッション
 *   POST   /v1/usage-budgets/suspensions/:sessionId/resume  中断したセッションを再開する ({ actor_user_id })
 *
 * @implements SPEC-USAGE-BUDGET-API
 */

import { Hono } from "hono";
import { z } from "zod";
import type { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import type { UsageBudgetMultipliersRepo } from "../db/usage-budget-multipliers-repo.js";
import type { GuildRoleList } from "../platform/guild-role-list.js";
import { budgetNoticeText, evaluateBudget } from "../cost/usage-budget.js";
import { subjectKey, type UsageBudgetTracker } from "../cost/usage-budget-tracker.js";
import { MAX_COST_MULTIPLIER } from "../cost/budget-multiplier.js";
import type { BudgetResumeResult } from "../cost/budget-resume.js";
import { isSuspended, readSuspension } from "../cost/budget-suspension.js";
import { userMonthlyUsageRows } from "../cost/user-monthly-usage.js";
import type { SessionRow } from "../shared/types.js";

const ScopeSchema = z.enum(["user", "team"]);
const TargetSchema = z.string().trim().min(1).max(200);
const PutSchema = z.object({
  limit_tokens: z.number().int().min(0).max(1_000_000_000_000),
  updated_by: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const DiscordIdSchema = z.string().trim().regex(/^\d{5,32}$/);
const MultiplierPutSchema = z.object({
  guild_id: DiscordIdSchema,
  multiplier: z.number().gt(0).max(MAX_COST_MULTIPLIER),
  updated_by: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const ResumeSchema = z.object({
  actor_user_id: z.string().trim().regex(/^\d{5,32}$/),
}).strict();

export interface UsageBudgetsApiDeps {
  budgets: UsageBudgetsRepo;
  tracker: UsageBudgetTracker;
  /** 属性 (Discord のロール) ごとの倍率。 未注入なら倍率の API は無い。 */
  multipliers?: UsageBudgetMultipliersRepo;
  /** 倍率を変えたときに捨てる、 人のロールのキャッシュ。 */
  invalidateRoleCache?: () => void;
  /** 倍率を設定できる Discord のロール。 未注入・Bot 停止中は空。 */
  discordRoles?: () => GuildRoleList[];
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

  app.get("/users", async (c) => {
    const snapshot = await deps.tracker.monthlySnapshot();
    return c.json({
      month: snapshot.month,
      users: userMonthlyUsageRows(snapshot.persons, deps.budgets.list(), snapshot.subjects),
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
    const changed = () => {
      deps.invalidateRoleCache?.();
      deps.tracker.invalidate();
    };
    app.get("/role-multipliers", (c) => c.json({ multipliers: multipliers.list() }));
    app.get("/discord-roles", (c) => c.json({ guilds: deps.discordRoles?.() ?? [] }));
    app.put("/role-multipliers/:roleId", async (c) => {
      const roleId = DiscordIdSchema.safeParse(c.req.param("roleId"));
      const body = MultiplierPutSchema.safeParse(await c.req.json().catch(() => null));
      if (!roleId.success || !body.success) return c.json({ error: "invalid_multiplier" }, 400);
      const multiplier = multipliers.upsert({
        role_id: roleId.data, guild_id: body.data.guild_id, multiplier: body.data.multiplier, updated_by: body.data.updated_by ?? null,
      });
      changed();
      return c.json({ multiplier });
    });
    app.delete("/role-multipliers/:roleId", (c) => {
      const roleId = DiscordIdSchema.safeParse(c.req.param("roleId"));
      if (!roleId.success) return c.json({ error: "invalid_multiplier" }, 400);
      const removed = multipliers.remove(roleId.data);
      changed();
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
