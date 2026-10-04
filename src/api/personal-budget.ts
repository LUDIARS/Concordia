/**
 * /v1/personal-budget — 個人の AI 予算 (月間分と報酬分) の一覧・台帳・月間分の上限・調整。
 *
 * loopback の管理 UI 専用 (他の管理 API と同じ信頼境界)。 残高・理由をログ・イベントへ出さない
 * (CC-PBUDGET-INV-08)。 一覧はページングし、 台帳は個人単位で取る。
 *
 * @implements SPEC-PBUDGET-VIEW
 * @implements SPEC-PBUDGET-ADJUST
 * @implements spec/feature/personal-ai-budget.md §7
 */

import { Hono } from "hono";
import { z } from "zod";
import type { PersonalBudgetPeopleRepo } from "../db/personal-budget-people-repo.js";
import type { PersonalBudgetLedgerRepo } from "../db/personal-budget-ledger-repo.js";
import type { PersonalBudgetAdjustments } from "../personal-budget/adjustment-service.js";
import { MAX_REASON_LENGTH } from "../personal-budget/adjustment-policy.js";
import { MAX_TOKENS_PER_ENTRY } from "../personal-budget/types.js";
import type { PersonalBudgetView } from "../personal-budget/view-service.js";

export interface PersonalBudgetApiDeps {
  people: PersonalBudgetPeopleRepo;
  ledger: PersonalBudgetLedgerRepo;
  view: PersonalBudgetView;
  adjustments: PersonalBudgetAdjustments;
  /** 会社が登録済みの子会社か (人を指して調整するときの確認)。 */
  subsidiaryExists: (subsidiaryId: string) => boolean;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

function pageOf(query: (name: string) => string | undefined): { limit: number; offset: number } {
  const limit = Number(query("limit"));
  const offset = Number(query("offset"));
  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_PAGE) : DEFAULT_PAGE,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
  };
}

const MonthlyLimitSchema = z.object({
  // null で子会社の既定値へ戻す。 0 は「この人は上限なし」。
  monthly_token_limit: z.number().int().min(0).max(MAX_TOKENS_PER_ENTRY).nullable(),
}).strict();

const AdjustmentSchema = z.object({
  person_id: z.string().trim().min(1).max(80).optional(),
  subsidiary_id: z.string().trim().min(1).max(120).optional(),
  platform: z.enum(["discord", "slack"]).optional(),
  platform_user_id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  display_name: z.string().max(100).optional(),
  tokens: z.number().int().min(-MAX_TOKENS_PER_ENTRY).max(MAX_TOKENS_PER_ENTRY),
  reason: z.string().max(MAX_REASON_LENGTH),
}).strict();

const ADJUSTMENT_STATUS: Record<string, 400 | 403 | 404 | 409> = {
  not_authorized: 403,
  person_not_found: 404,
  nothing_to_reduce: 409,
};

export function personalBudgetRouter(deps: PersonalBudgetApiDeps): Hono {
  const app = new Hono();

  app.get("/people", (c) => {
    const subsidiaryId = c.req.query("subsidiary_id")?.trim() || null;
    const page = pageOf((name) => c.req.query(name));
    const { people, total } = deps.people.list({ subsidiaryId, ...page });
    return c.json({
      people: people.map((person) => {
        const summary = deps.view.summarize(person);
        return {
          id: person.id,
          subsidiary_id: person.subsidiary_id,
          platform: person.platform,
          platform_user_id: person.platform_user_id,
          display_name: person.display_name,
          monthly_token_limit_override: person.monthly_token_limit,
          period: summary.period,
          monthly_limit: summary.monthlyLimit,
          monthly_used: summary.monthlyUsed,
          monthly_remaining: summary.monthlyRemaining,
          reward_balance: summary.rewardBalance,
        };
      }),
      total,
      ...page,
    });
  });

  app.get("/people/:id/ledger", (c) => {
    const person = deps.people.findById(c.req.param("id"));
    if (!person) return c.json({ error: "person_not_found" }, 404);
    const page = pageOf((name) => c.req.query(name));
    const { entries, total } = deps.ledger.listForPerson(person.id, page);
    return c.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        entry_type: entry.entry_type,
        tokens: entry.tokens,
        reward_kind: entry.reward_kind,
        source_ref: entry.source_ref,
        session_id: entry.session_id,
        period: entry.period,
        actor: entry.actor,
        reason: entry.reason,
        notify_state: entry.notify_state,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      })),
      total,
      ...page,
    });
  });

  app.put("/people/:id/monthly-limit", async (c) => {
    const parsed = MonthlyLimitSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_monthly_limit", detail: parsed.error.flatten() }, 400);
    const person = deps.people.setMonthlyLimit(c.req.param("id"), parsed.data.monthly_token_limit);
    if (!person) return c.json({ error: "person_not_found" }, 404);
    const summary = deps.view.summarize(person);
    return c.json({
      person: {
        id: person.id,
        monthly_token_limit_override: person.monthly_token_limit,
        monthly_limit: summary.monthlyLimit,
        monthly_used: summary.monthlyUsed,
        monthly_remaining: summary.monthlyRemaining,
      },
    });
  });

  app.post("/adjustments", async (c) => {
    const parsed = AdjustmentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_adjustment", detail: parsed.error.flatten() }, 400);
    const body = parsed.data;
    let target: Parameters<PersonalBudgetAdjustments["adjust"]>[0]["target"];
    if (body.person_id) {
      target = { personId: body.person_id };
    } else if (body.subsidiary_id && body.platform && body.platform_user_id) {
      if (!deps.subsidiaryExists(body.subsidiary_id)) return c.json({ error: "subsidiary_not_found" }, 404);
      // 管理 UI では会社を明示して指す。 本社 (会社なし) は指定できないので対象にならない。
      target = {
        platform: body.platform,
        platformUserId: body.platform_user_id,
        displayName: body.display_name,
        memberships: [body.subsidiary_id],
        requestedSubsidiaryId: body.subsidiary_id,
      };
    } else {
      return c.json({ error: "adjustment_target_required" }, 400);
    }
    const outcome = deps.adjustments.adjust({
      // この API に届くのは本社の管理 UI だけ (loopback の信頼境界)。 操作者は webui として残す。
      actor: { id: "webui", authorized: true },
      target,
      tokens: body.tokens,
      reason: body.reason,
    });
    if (!outcome.ok) {
      return c.json({ error: outcome.error, message: outcome.message }, ADJUSTMENT_STATUS[outcome.error] ?? 400);
    }
    return c.json({
      person_id: outcome.person.id,
      entry: { id: outcome.entry.id, tokens: outcome.entry.tokens, reason: outcome.entry.reason, created_at: outcome.entry.created_at },
      reward_balance: outcome.rewardBalance,
    });
  });

  return app;
}
