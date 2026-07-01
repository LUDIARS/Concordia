import { describe, expect, it } from "vitest";
import { collectLimitSamples } from "./limit-sampler.js";
import type { CostReport } from "./cost-report.js";
import type { CostLimitSampleRow } from "../db/cost-limit-samples-repo.js";

function report(): CostReport {
  return {
    codexTotals: { input: 0, cached: 0, output: 0, total: 0 },
    claudeTotals: { input: 0, cached: 0, output: 0, total: 0 },
    codexRate: { used5h: null, usedWeekly: null, reset5hAt: null, resetWeeklyAt: null, plan: null },
    claudeUsage: null,
  };
}

describe("collectLimitSamples", () => {
  it("carries forward previous provider values when current limit telemetry is unavailable", () => {
    const previous: CostLimitSampleRow[] = [
      {
        id: 1,
        ts: 1000,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: 25,
        used_weekly_pct: 50,
        reset_5h_at: 2000,
        reset_weekly_at: 3000,
      },
      {
        id: 2,
        ts: 1000,
        provider: "claude-code",
        plan: "max",
        used_5h_pct: 10,
        used_weekly_pct: 20,
        reset_5h_at: 4000,
        reset_weekly_at: 5000,
      },
    ];

    expect(collectLimitSamples(report(), 1600, previous)).toEqual([
      {
        ts: 1600,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: 25,
        used_weekly_pct: 50,
        reset_5h_at: 2000,
        reset_weekly_at: 3000,
      },
      {
        ts: 1600,
        provider: "claude-code",
        plan: "max",
        used_5h_pct: 10,
        used_weekly_pct: 20,
        reset_5h_at: 4000,
        reset_weekly_at: 5000,
      },
    ]);
  });

  it("fills only missing fields from the previous sample", () => {
    const r = report();
    r.codexRate = { used5h: 40, usedWeekly: null, reset5hAt: 2200, resetWeeklyAt: null, plan: null };

    const samples = collectLimitSamples(r, 1600, [
      {
        id: 1,
        ts: 1000,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: 25,
        used_weekly_pct: 50,
        reset_5h_at: 2000,
        reset_weekly_at: 3000,
      },
    ]);

    expect(samples[0]).toMatchObject({
      provider: "codex-cli",
      plan: "pro",
      used_5h_pct: 40,
      used_weekly_pct: 50,
      reset_5h_at: 2200,
      reset_weekly_at: 3000,
    });
  });
});
