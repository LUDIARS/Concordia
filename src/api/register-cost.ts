import type { Hono } from "hono";
import type { AdminState } from "../admin/state.js";
import type { CostLimitSamplesRepo } from "../db/cost-limit-samples-repo.js";
import type { CostOneShotCallsRepo } from "../db/cost-one-shot-calls-repo.js";
import type { CostUsageSamplesRepo } from "../db/cost-usage-samples-repo.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SubsidiaryRepo } from "../db/subsidiary-repo.js";
import type { CostBudgetStatus } from "../cost/usage-tracker.js";
import { costFeedRouter } from "./cost-feed.js";
import { costRouter } from "./cost.js";

export interface CostDeps {
  repo: SessionsRepo;
  discordChannels: DiscordSessionChannelsRepo;
  costSamples: CostUsageSamplesRepo;
  costLimitSamples: CostLimitSamplesRepo;
  costOneShots: CostOneShotCallsRepo;
  subsidiary?: SubsidiaryRepo;
  adminState: AdminState;
  costStatus?: () => CostBudgetStatus;
}

export function registerCostRoutes(app: Hono, deps: CostDeps): void {
  app.route("/v1/cost-feed", costFeedRouter());
  app.route(
    "/v1/cost",
    costRouter({
      sessions: deps.repo,
      resolveSessionChannelId: (sessionId) => deps.discordChannels.findBySessionId(sessionId)?.channel_id ?? null,
      samples: deps.costSamples,
      limitSamples: deps.costLimitSamples,
      oneShots: deps.costOneShots,
      listSubsidiaries: () =>
        deps.subsidiary
          ? deps.subsidiary
              .list()
              .map((s) => ({ id: s.id, name: s.display_name || s.name, daily_token_budget: s.daily_token_budget }))
          : [],
    }),
  );

  app.get("/v1/admin/cost-budget", (c) => {
    const status = deps.costStatus?.() ?? null;
    return c.json({
      daily_token_budget: deps.adminState.getDailyTokenBudget(),
      today_tokens: status?.todayTokens ?? 0,
      blocked: status?.blocked ?? false,
      date_iso: status?.dateIso ?? null,
    });
  });
  app.put("/v1/admin/cost-budget", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.daily_token_budget !== "number" || !Number.isFinite(body.daily_token_budget)) {
      return c.json({ error: "body.daily_token_budget (number, 0=disabled) required" }, 400);
    }
    deps.adminState.setDailyTokenBudget(body.daily_token_budget);
    const status = deps.costStatus?.() ?? null;
    return c.json({
      daily_token_budget: deps.adminState.getDailyTokenBudget(),
      today_tokens: status?.todayTokens ?? 0,
      blocked: status?.blocked ?? false,
    });
  });
}
