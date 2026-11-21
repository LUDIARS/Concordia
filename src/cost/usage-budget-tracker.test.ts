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
        { atMs: (startSec + 1) * 1000, tokens: 400, turnEnd: true },
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

  it("awaits an async (Discord role) multiplier and falls back to 1 when it fails", async () => {
    const budgets = new UsageBudgetsRepo(makeTestDb());
    const sessions = [session("s1", { requester: "111111111" }), session("s2", { requester: "333333333" })];
    const tracker = new UsageBudgetTracker({
      budgets,
      sessionsInRange: () => sessions,
      readUsage: async () => ({ total: 100 }),
      roleMultiplier: async (userId) => {
        if (userId === "333333333") throw new Error("discord unavailable");
        return 0.5;
      },
      now: () => NOW,
    });
    const totals = await tracker.monthlyConsumption();
    expect(totals.get("user:111111111")).toBe(50);
    expect(totals.get("user:333333333")).toBe(100);
  });

  it("shares one AI turn by instruction count, applies each person's multiplier and totals per person", async () => {
    const s1 = session("s1", { team: "team_a", requester: "111111111" });
    const startSec = Math.floor(NOW / 1000) - 100;
    const inject = (id: number, offset: number, userId: string) => ({
      id, session_id: "s1", ts: startSec + offset, kind: "inject", payload: JSON.stringify({ source: `discord:${userId}:1:${id}` }),
    });
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [s1],
      readUsage: async () => ({ total: 999_999 }),
      readTimeline: async () => [
        { atMs: (startSec + 40) * 1000, tokens: 600 },
        { atMs: (startSec + 50) * 1000, tokens: 300, turnEnd: true },
      ],
      // 同じ応答の区間に起動者が 2 回、 助けに入った人が 1 回指示した。
      sessionEvents: () => [inject(1, 10, "111111111"), inject(2, 20, "222222222"), inject(3, 30, "111111111")],
      roleMultiplier: (userId) => (userId === "222222222" ? 0.5 : 1),
      now: () => NOW,
    });
    const snapshot = await tracker.monthlySnapshot();
    // 900 を 2/3 (起動者 → チーム) と 1/3 (助けに入った人) に分け、 倍率は分けた額に人ごとに掛ける。
    expect(snapshot.subjects.get("team:team_a")).toBe(600);
    expect(snapshot.subjects.get("user:222222222")).toBe(150);
    expect(snapshot.persons.get("111111111")).toEqual({ total: 600, team: 600 });
    expect(snapshot.persons.get("222222222")).toEqual({ total: 150, team: 0 });
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

  it("runs one count at a time and shares it with callers that arrive meanwhile", async () => {
    let release: (value: { total: number }) => void = () => undefined;
    const readUsage = vi.fn(() => new Promise<{ total: number }>((resolve) => { release = resolve; }));
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [session("s1", { requester: "111111111" })],
      readUsage,
      now: () => NOW,
    });
    const first = tracker.monthlySnapshot();
    const second = tracker.monthlySnapshot();
    const third = tracker.cachedMonthlyConsumption();
    await vi.waitFor(() => expect(readUsage).toHaveBeenCalledTimes(1));
    release({ total: 40 });
    expect((await first).subjects.get("user:111111111")).toBe(40);
    expect(await second).toBe(await first);
    expect((await third).get("user:111111111")).toBe(40);
    expect(readUsage).toHaveBeenCalledTimes(1);
    // 終わった後の呼び出しは数え直す (起動の可否は最新で判定する)。
    const again = tracker.monthlySnapshot();
    await vi.waitFor(() => expect(readUsage).toHaveBeenCalledTimes(2));
    release({ total: 40 });
    await again;
  });

  it("does not cache a count that was invalidated while it ran", async () => {
    // invalidate の後の呼び出しは、 走っている古い集計を待たずにすぐ数え直す。
    const releases: Array<(value: { total: number }) => void> = [];
    const readUsage = vi.fn(() => new Promise<{ total: number }>((resolve) => { releases.push(resolve); }));
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [session("s1", { requester: "111111111" })],
      readUsage,
      now: () => NOW,
    });
    const stale = tracker.cachedMonthlySnapshot();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    tracker.invalidate();
    const fresh = tracker.cachedMonthlySnapshot();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!({ total: 20 });
    expect((await fresh).subjects.get("user:111111111")).toBe(20);
    // 古い集計が後から終わっても、 キャッシュは新しい結果のまま。
    releases[0]!({ total: 10 });
    expect((await stale).subjects.get("user:111111111")).toBe(10);
    expect((await tracker.cachedMonthlySnapshot()).subjects.get("user:111111111")).toBe(20);
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("reads a settled ended session once, and again after it is resumed", async () => {
    const endedSec = Math.floor(NOW / 1000) - 3_600;
    const ended = { ...session("s1", { requester: "111111111" }), ended_at: endedSec, last_seen_at: endedSec } as SessionRow;
    const live = { ...session("s2", { requester: "111111111" }), ended_at: null, last_seen_at: Math.floor(NOW / 1000) } as SessionRow;
    const sessions = [ended, live];
    const readUsage = vi.fn(async (s: SessionRow) => ({ total: s.id === "s1" ? 100 : 5 }));
    const roleMultiplier = vi.fn(() => 2);
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => sessions,
      readUsage,
      roleMultiplier,
      now: () => NOW,
    });
    expect((await tracker.monthlyConsumption()).get("user:111111111")).toBe(210);
    // 倍率は覚えないので、 変えた倍率は覚えた按分にも掛かる。
    roleMultiplier.mockReturnValue(1);
    expect((await tracker.monthlyConsumption()).get("user:111111111")).toBe(105);
    expect(readUsage.mock.calls.map(([s]) => s.id)).toEqual(["s1", "s2", "s2"]);
    sessions[0] = { ...ended, last_seen_at: Math.floor(NOW / 1000) } as SessionRow;
    await tracker.monthlyConsumption();
    expect(readUsage.mock.calls.filter(([s]) => s.id === "s1")).toHaveLength(2);
  });

  it("does not remember an ended session whose usage could not be read", async () => {
    const endedSec = Math.floor(NOW / 1000) - 3_600;
    const ended = { ...session("s1", { requester: "111111111" }), ended_at: endedSec, last_seen_at: endedSec } as SessionRow;
    const readUsage = vi.fn<(s: SessionRow) => Promise<{ total: number } | null>>(async () => null);
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [ended],
      readUsage,
      now: () => NOW,
    });
    expect((await tracker.monthlyConsumption()).get("user:111111111")).toBeUndefined();
    readUsage.mockResolvedValue({ total: 30 });
    expect((await tracker.monthlyConsumption()).get("user:111111111")).toBe(30);
  });

  it("does not read inject events for a session without a launch subject", async () => {
    // 帰属先が無いセッションは何も消費しないので、 inject イベントを読む前に抜ける。
    const sessionEvents = vi.fn((_sessionId: string) => []);
    const readUsage = vi.fn(async (_s: SessionRow) => ({ total: 100 }));
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [session("s1", {}), session("s2", { requester: "111111111" })],
      readUsage,
      sessionEvents,
      now: () => NOW,
    });
    const totals = await tracker.monthlyConsumption();
    expect([...totals.entries()]).toEqual([["user:111111111", 100]]);
    expect(sessionEvents.mock.calls.map(([id]) => id)).toEqual(["s2"]);
    expect(readUsage.mock.calls.map(([s]) => s.id)).toEqual(["s2"]);
  });

  it("does not read inject events for a remembered (settled) ended session and keeps the same totals", async () => {
    const endedSec = Math.floor(NOW / 1000) - 3_600;
    const ended = { ...session("s1", { requester: "111111111" }), ended_at: endedSec, last_seen_at: endedSec } as SessionRow;
    const helperInject = {
      id: 1, session_id: "s1", ts: endedSec - 30, kind: "inject", payload: JSON.stringify({ source: "discord:222222222:1:2" }),
    };
    const sessionEvents = vi.fn(() => [helperInject]);
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [ended],
      readUsage: async () => ({ total: 999 }),
      readTimeline: async () => [
        { atMs: (endedSec - 60) * 1000, tokens: 300, turnEnd: true },
        { atMs: (endedSec - 10) * 1000, tokens: 700 },
      ],
      sessionEvents,
      now: () => NOW,
    });
    const first = await tracker.monthlySnapshot();
    const second = await tracker.monthlySnapshot();
    // 覚えた按分は前提を使わないので、 2 回目は inject イベントを読まない。 結果は 1 回目 (前提を読んだ集計) と同じ。
    expect(sessionEvents).toHaveBeenCalledTimes(1);
    expect(second.subjects).toEqual(first.subjects);
    expect(second.persons).toEqual(first.persons);
    expect(first.subjects.get("user:111111111")).toBe(300);
    expect(first.subjects.get("user:222222222")).toBe(700);
  });

  it("answers hasAnyBudget from memory and reads it again after invalidate", () => {
    const budgets = new UsageBudgetsRepo(makeTestDb());
    const list = vi.spyOn(budgets, "list");
    const tracker = new UsageBudgetTracker({
      budgets,
      sessionsInRange: () => [],
      readUsage: async () => null,
      now: () => NOW,
    });
    expect(tracker.hasAnyBudget()).toBe(false);
    expect(tracker.hasAnyBudget()).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
    budgets.upsert({ scope: "user", target_id: "111111111", limit_tokens: 1_000, updated_by: null });
    // 予算を書く側 (管理 API) は invalidate を呼ぶ。
    tracker.invalidate();
    expect(tracker.hasAnyBudget()).toBe(true);
    budgets.remove("user", "111111111");
    tracker.invalidate();
    expect(tracker.hasAnyBudget()).toBe(false);
  });

  it("serves the stale snapshot at once after the TTL and recounts once in the background", async () => {
    let clock = NOW;
    let calls = 0;
    let release: (value: { total: number }) => void = () => undefined;
    const readUsage = vi.fn(() => new Promise<{ total: number }>((resolve) => {
      calls += 1;
      if (calls === 1) resolve({ total: 10 });
      else release = resolve;
    }));
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [session("s1", { requester: "111111111" })],
      readUsage,
      now: () => clock,
      cacheTtlMs: 1_000,
    });
    expect((await tracker.cachedMonthlyConsumption()).get("user:111111111")).toBe(10);
    clock += 1_000;
    // 期限切れ: 古い値をすぐ返し (数え直しを待たない)、 同時に来た呼び出しは 1 本の数え直しを共有する。
    const [a, b, c] = await Promise.all([
      tracker.cachedMonthlyConsumption(),
      tracker.cachedMonthlyConsumption(),
      tracker.cachedMonthlySnapshot(),
    ]);
    expect(a.get("user:111111111")).toBe(10);
    expect(b.get("user:111111111")).toBe(10);
    expect(c.subjects.get("user:111111111")).toBe(10);
    expect(readUsage).toHaveBeenCalledTimes(2);
    release({ total: 20 });
    await vi.waitFor(async () => expect((await tracker.cachedMonthlyConsumption()).get("user:111111111")).toBe(20));
    expect(readUsage).toHaveBeenCalledTimes(2);
  });

  it("drops the stale snapshot when the background recount fails so the next caller sees the failure", async () => {
    let clock = NOW;
    let fail = false;
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => {
        if (fail) throw new Error("db unavailable");
        return [session("s1", { requester: "111111111" })];
      },
      readUsage: async () => ({ total: 10 }),
      now: () => clock,
      cacheTtlMs: 1_000,
    });
    await tracker.cachedMonthlySnapshot();
    clock += 1_000;
    fail = true;
    expect((await tracker.cachedMonthlyConsumption()).get("user:111111111")).toBe(10);
    await vi.waitFor(() => expect(tracker.cachedMonthlySnapshot()).rejects.toThrow("db unavailable"));
  });

  it("counts the TTL from when the count finished, not when it started", async () => {
    let clock = NOW;
    const readUsage = vi.fn(async () => {
      // 集計に 5 秒かかる。
      clock += 5_000;
      return { total: 10 };
    });
    const tracker = new UsageBudgetTracker({
      budgets: new UsageBudgetsRepo(makeTestDb()),
      sessionsInRange: () => [session("s1", { requester: "111111111" })],
      readUsage,
      now: () => clock,
      cacheTtlMs: 3_000,
    });
    await tracker.cachedMonthlySnapshot();
    expect(readUsage).toHaveBeenCalledTimes(1);
    // 始めた時刻から数えれば期限切れ (7 秒 > 3 秒) だが、 終わってから 2 秒なのでまだ新しい。
    clock += 2_000;
    await tracker.cachedMonthlySnapshot();
    expect(readUsage).toHaveBeenCalledTimes(1);
    // 終わってから 3 秒で期限切れになり、 数え直す。
    clock += 1_000;
    await tracker.cachedMonthlySnapshot();
    await vi.waitFor(() => expect(readUsage).toHaveBeenCalledTimes(2));
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
