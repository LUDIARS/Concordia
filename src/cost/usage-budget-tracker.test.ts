import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetsRepo } from "../db/usage-budgets-repo.js";
import type { SessionRow } from "../shared/types.js";
import { UsageBudgetTracker } from "./usage-budget-tracker.js";

const NOW = new Date(2026, 9, 15, 12).getTime();

function session(id: string, input: { team?: string; requester?: string; startedMs?: number }): SessionRow {
  return {
    id,
    team_id: input.team ?? null,
    started_at: Math.floor((input.startedMs ?? NOW) / 1000),
    metadata: input.requester ? JSON.stringify({ discord_requester_user_id: input.requester }) : null,
  } as unknown as SessionRow;
}

function setup(sessions: SessionRow[], usage: Record<string, number>) {
  const budgets = new UsageBudgetsRepo(makeTestDb());
  const tracker = new UsageBudgetTracker({
    budgets,
    sessionsInRange: (start, end) => sessions.filter((s) => s.started_at * 1000 >= start && s.started_at * 1000 < end),
    readUsage: async (s) => (s.id in usage ? { total: usage[s.id]! } : null),
    now: () => NOW,
  });
  return { budgets, tracker };
}

describe("UsageBudgetTracker", () => {
  it("counts this month's sessions to the team when launched by a team, otherwise to the requester", async () => {
    const { tracker } = setup([
      session("s1", { requester: "111111111" }),
      session("s2", { team: "team_a", requester: "111111111" }),
      session("s3", { requester: "111111111", startedMs: new Date(2026, 8, 30).getTime() }),
    ], { s1: 300, s2: 500, s3: 9_999 });
    const totals = await tracker.monthlyConsumption();
    expect(totals.get("user:111111111")).toBe(300);
    expect(totals.get("team:team_a")).toBe(500);
  });

  it("allows launches without a budget and stops them once the budget is used up", async () => {
    const { budgets, tracker } = setup([session("s1", { requester: "111111111" })], { s1: 1_000 });
    expect(await tracker.checkLaunch({ teamId: null, requesterUserId: "111111111" })).toMatchObject({ allowed: true, evaluation: null });
    budgets.upsert({ scope: "user", target_id: "111111111", limit_tokens: 2_000, updated_by: null });
    expect((await tracker.checkLaunch({ teamId: null, requesterUserId: "111111111" })).allowed).toBe(true);
    budgets.upsert({ scope: "user", target_id: "111111111", limit_tokens: 1_000, updated_by: null });
    expect(await tracker.checkLaunch({ teamId: null, requesterUserId: "111111111" }))
      .toMatchObject({ allowed: false, subject: { scope: "user" }, evaluation: { exhausted: true } });
    // チームで起動するならチームの予算を見る (個人の予算は消費しない)。
    expect((await tracker.checkLaunch({ teamId: "team_a", requesterUserId: "111111111" })).allowed).toBe(true);
  });

  it("splits a session by who gave the instruction and applies department and role multipliers", async () => {
    const s1 = { ...session("s1", { requester: "111111111" }), department_id: "dept_consult" } as SessionRow;
    const budgets = new UsageBudgetsRepo(makeTestDb());
    const startSec = Math.floor(NOW / 1000) - 100;
    const tracker = new UsageBudgetTracker({
      budgets,
      sessionsInRange: () => [s1],
      readUsage: async () => ({ total: 999_999 }),
      readTimeline: async () => [
        { atMs: (startSec + 1) * 1000, tokens: 400 },
        { atMs: (startSec + 60) * 1000, tokens: 800 },
      ],
      sessionEvents: () => [
        { id: 1, session_id: "s1", ts: startSec + 30, kind: "inject", payload: JSON.stringify({ source: "discord:222222222:1:2" }) },
      ],
      departmentMultiplier: (id) => (id === "dept_consult" ? 0.25 : 1),
      roleMultiplier: (userId) => (userId === "222222222" ? 2 : 1),
      now: () => NOW,
    });
    const totals = await tracker.monthlyConsumption();
    // 起動者の区間 400 × 0.25 × 1、 助けに入った人の区間 800 × 0.25 × 2。
    expect(totals.get("user:111111111")).toBe(100);
    expect(totals.get("user:222222222")).toBe(400);
  });

  it("caches the monthly consumption for the gate and recounts after invalidate", async () => {
    const budgets = new UsageBudgetsRepo(makeTestDb());
    const readUsage = vi.fn(async () => ({ total: 10 }));
    const tracker = new UsageBudgetTracker({
      budgets,
      sessionsInRange: () => [session("s1", { requester: "111111111" })],
      readUsage,
      now: () => NOW,
    });
    await tracker.cachedMonthlyConsumption();
    await tracker.cachedMonthlyConsumption();
    expect(readUsage).toHaveBeenCalledTimes(1);
    tracker.invalidate();
    await tracker.cachedMonthlyConsumption();
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("delivers each threshold notice once a month and retries a failed delivery", async () => {
    const { budgets, tracker } = setup([session("s1", { requester: "111111111" })], { s1: 850 });
    budgets.upsert({ scope: "user", target_id: "111111111", limit_tokens: 1_000, updated_by: null });
    const failing = vi.fn(async () => false);
    expect(await tracker.sweepNotices(failing)).toEqual([]);
    const deliver = vi.fn(async () => true);
    expect((await tracker.sweepNotices(deliver)).map((n) => n.threshold)).toEqual([80]);
    expect(await tracker.sweepNotices(deliver)).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
