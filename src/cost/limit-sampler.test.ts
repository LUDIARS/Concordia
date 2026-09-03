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

  // 廃止された枠の最終値を無期限に複製しない。
  it("stops carrying a value forward once the previous sample is too old", () => {
    const previous: CostLimitSampleRow[] = [
      {
        id: 1,
        ts: 1000,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: 71,
        used_weekly_pct: 50,
        reset_5h_at: 2000,
        reset_weekly_at: 3000,
      },
    ];

    // 30 分ちょうどまでは埋める (10 分毎の取得が数回失敗しただけ)。
    expect(collectLimitSamples(report(), 1000 + 30 * 60, previous)[0]).toMatchObject({
      used_5h_pct: 71,
      used_weekly_pct: 50,
      plan: "pro",
    });

    // それを超えたら「取れていない」を時系列に残す。
    expect(collectLimitSamples(report(), 1000 + 30 * 60 + 1, previous)[0]).toMatchObject({
      provider: "codex-cli",
      plan: null,
      used_5h_pct: null,
      used_weekly_pct: null,
      reset_5h_at: null,
      reset_weekly_at: null,
    });
  });

  it("does not carry a future-dated previous sample backward", () => {
    const previous: CostLimitSampleRow[] = [
      {
        id: 1,
        ts: 2000,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: 71,
        used_weekly_pct: 50,
        reset_5h_at: 3000,
        reset_weekly_at: 4000,
      },
    ];

    expect(collectLimitSamples(report(), 1000, previous)[0]).toMatchObject({
      provider: "codex-cli",
      plan: null,
      used_5h_pct: null,
      used_weekly_pct: null,
      reset_5h_at: null,
      reset_weekly_at: null,
    });
  });

  // 枠が 1 つだけ無くなった提供元は、 生きている枠の値まで道連れにしない。
  it("keeps a live window while the retired one goes null", () => {
    const r = report();
    r.codexRate = { used5h: null, usedWeekly: 57, reset5hAt: null, resetWeeklyAt: 9000, plan: "pro" };

    const samples = collectLimitSamples(r, 1000 + 3 * 24 * 3600, [
      {
        id: 1,
        ts: 1000,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: 71,
        used_weekly_pct: 50,
        reset_5h_at: 2000,
        reset_weekly_at: 3000,
      },
    ]);

    expect(samples[0]).toMatchObject({
      used_5h_pct: null,
      reset_5h_at: null,
      used_weekly_pct: 57,
      reset_weekly_at: 9000,
    });
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
