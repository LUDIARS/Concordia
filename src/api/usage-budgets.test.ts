import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import { UsageBudgetTracker } from "../cost/usage-budget-tracker.js";
import type { SessionRow } from "../shared/types.js";
import { usageBudgetsRouter } from "./usage-budgets.js";

function setup() {
  const budgets = new UsageBudgetsRepo(makeTestDb());
  const now = Date.now();
  const sessions = [{ id: "s1", team_id: null, started_at: Math.floor(now / 1000), metadata: JSON.stringify({ discord_requester_user_id: "123456789" }) }] as unknown as SessionRow[];
  const tracker = new UsageBudgetTracker({
    budgets,
    sessionsInRange: () => sessions,
    readUsage: async () => ({ total: 1_000 }),
    now: () => now,
  });
  return { app: usageBudgetsRouter({ budgets, tracker }), budgets };
}

describe("usage budgets API", () => {
  it("sets a budget, lists it with this month's consumption and removes it", async () => {
    const { app } = setup();
    const put = await app.request("/user/123456789", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit_tokens: 4_000, updated_by: "900" }),
    });
    expect(put.status).toBe(200);
    const listed = await (await app.request("/")).json() as { budgets: Array<Record<string, unknown>> };
    expect(listed.budgets).toEqual([expect.objectContaining({ scope: "user", target_id: "123456789", consumed_tokens: 1_000, ratio: 0.25 })]);
    expect(await (await app.request("/user/123456789", { method: "DELETE" })).json()).toEqual({ removed: true });
  });

  it("rejects an invalid scope or limit", async () => {
    const { app } = setup();
    expect((await app.request("/org/1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit_tokens: 1 }) })).status).toBe(400);
    expect((await app.request("/user/1", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit_tokens: -1 }) })).status).toBe(400);
  });

  it("answers whether a launch may start and explains a used-up budget", async () => {
    const { app, budgets } = setup();
    expect(await (await app.request("/check?user=123456789")).json()).toMatchObject({ allowed: true });
    budgets.upsert({ scope: "user", target_id: "123456789", limit_tokens: 1_000, updated_by: null });
    expect(await (await app.request("/check?user=123456789")).json())
      .toMatchObject({ allowed: false, exhausted: true, notice: expect.stringContaining("使い切りました") });
  });
});
