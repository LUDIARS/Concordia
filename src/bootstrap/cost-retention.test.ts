import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { createCostRuntime } from "./cost.js";

vi.mock("../cost/cost-report.js", () => ({
  collectCostReport: vi.fn(async () => ({
    codexTotals: { input: 0, cached: 0, output: 0, total: 0 },
    claudeTotals: { input: 0, cached: 0, output: 0, total: 0 },
    codexRate: { used5h: null, usedWeekly: 10, reset5hAt: null, resetWeeklyAt: null, plan: "pro" },
    claudeUsage: null,
  })),
}));

describe("CC-COST-LIMIT-HISTORY-90D", () => {
  afterEach(() => vi.useRealTimers());

  it("retains observations at the 90-day boundary and removes older ones in the real sampler", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T03:00:00Z"));
    const db = makeTestDb();
    const runtime = createCostRuntime({ db, sessionsRepo: new SessionsRepo(db), getDailyTokenBudget: () => 0 });
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 90 * 86400;
    try {
      for (const ts of [cutoff - 1, cutoff, now - 61 * 86400]) {
        runtime.limitSamplesRepo.insert({ ts, provider: "codex-cli", plan: "pro", used_5h_pct: null,
          used_weekly_pct: 25, reset_5h_at: null, reset_weekly_at: null });
      }
      await runtime.sampleLimitsOnce();
      expect(runtime.limitSamplesRepo.listSince(0).map((row) => row.ts)).toEqual([cutoff, now - 61 * 86400, now]);
      expect(runtime.isRunning()).toBe(false);
    } finally {
      runtime.stop();
      db.close();
    }
  });
});
