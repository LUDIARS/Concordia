import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import { UsageBudgetMultipliersRepo } from "../db/usage-budget-multipliers-repo.js";
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

describe("usage budgets API — role multipliers and suspensions", () => {
  function setupWith(overrides: Partial<Parameters<typeof usageBudgetsRouter>[0]> = {}) {
    const db = makeTestDb();
    const budgets = new UsageBudgetsRepo(db);
    const multipliers = new UsageBudgetMultipliersRepo(db);
    const now = Date.now();
    const sessions = [{ id: "s1", team_id: null, started_at: Math.floor(now / 1000), metadata: JSON.stringify({ discord_requester_user_id: "123456789" }) }] as unknown as SessionRow[];
    const tracker = new UsageBudgetTracker({
      budgets,
      sessionsInRange: () => sessions,
      readUsage: async () => ({ total: 1_000 }),
      roleMultiplier: () => multipliers.find("staff")?.multiplier ?? 1,
      now: () => now,
    });
    return { app: usageBudgetsRouter({ budgets, tracker, multipliers, ...overrides }), multipliers };
  }
  const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("edits a role multiplier and counts consumption with it", async () => {
    const { app } = setupWith();
    await app.request("/user/123456789", { method: "PUT", ...json({ limit_tokens: 4_000 }) });
    const put = await app.request("/role-multipliers/staff", { method: "PUT", ...json({ multiplier: 2 }) });
    expect(put.status).toBe(200);
    expect(await (await app.request("/role-multipliers")).json()).toMatchObject({ multipliers: [{ role: "staff", multiplier: 2 }] });
    const listed = await (await app.request("/")).json() as { budgets: Array<Record<string, unknown>> };
    expect(listed.budgets[0]).toMatchObject({ consumed_tokens: 2_000 });
    expect((await app.request("/role-multipliers/staff", { method: "PUT", ...json({ multiplier: 0 }) })).status).toBe(400);
    expect((await app.request("/role-multipliers/boss", { method: "PUT", ...json({ multiplier: 1 }) })).status).toBe(400);
    expect(await (await app.request("/role-multipliers/staff", { method: "DELETE" })).json()).toEqual({ removed: true });
  });

  it("lists suspended sessions and passes a resume with the pressing user", async () => {
    const suspended = {
      id: "s9",
      metadata: JSON.stringify({ budget_suspension: { suspended_at: 1, scope: "user", target_id: "123456789", conversation_id: null, cwd: null, participants: [] } }),
    } as unknown as SessionRow;
    const resume = vi.fn(async () => ({ ok: false as const, status: 403 as const, error: "resume_not_allowed" }));
    const { app } = setupWith({ listSuspended: () => [suspended], resume });
    expect(await (await app.request("/suspensions")).json()).toMatchObject({ suspensions: [{ session_id: "s9", target_id: "123456789" }] });
    const res = await app.request("/suspensions/s9/resume", { method: "POST", ...json({ actor_user_id: "987654321" }) });
    expect(res.status).toBe(403);
    expect(resume).toHaveBeenCalledWith("s9", "987654321");
    expect((await app.request("/suspensions/s9/resume", { method: "POST", ...json({}) })).status).toBe(400);
  });
});
