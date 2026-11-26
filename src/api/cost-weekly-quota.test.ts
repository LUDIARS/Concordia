import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostLimitSampleRow } from "../db/cost-limit-samples-repo.js";
import type { GrokUsage } from "../cost/grok-usage.js";
import { costRouter, type CostApiDeps } from "./cost.js";

function sample(provider: string, used: number | null, reset: number | null): CostLimitSampleRow {
  return {
    id: 1, ts: 800, provider, plan: "saved",
    used_5h_pct: 25, reset_5h_at: 5000, used_weekly_pct: used, reset_weekly_at: reset,
  };
}

const liveGrok = { plan: "SuperGrok", usedWeeklyPct: 91.34, resetWeeklyAt: 3000, observedAtSec: 900 };

function router(samples: CostLimitSampleRow[], grok: GrokUsage | null = liveGrok) {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const readGrokUsage = vi.fn(async () => grok);
  const listLatestByProvider = vi.fn(() => samples);
  const app = costRouter({
    readGrokUsage,
    limitSamples: { listLatestByProvider },
  } as unknown as CostApiDeps);
  return { app, readGrokUsage, listLatestByProvider };
}

afterEach(() => vi.restoreAllMocks());

describe("GET /limits/latest", () => {
  it("returns fixed ordered providers and uses the freshest Grok observation", async () => {
    const { app, readGrokUsage, listLatestByProvider } = router([
      sample("grok-cli", 30, 2000),
      sample("claude-code", 4, 1000),
      sample("codex-cli", 31.24, null),
    ]);
    const response = await app.request("/limits/latest");
    expect(response.status).toBe(200);
    expect(listLatestByProvider).toHaveBeenCalledOnce();
    expect(readGrokUsage).toHaveBeenCalledWith({ nowSec: 1000 });
    expect(await response.json()).toEqual({ providers: [
      { key: "chatgpt", provider: "codex-cli", label: "ChatGPT", plan: "saved", usedWeeklyPct: 31.24, remainWeeklyPct: 68.8, resetWeeklyAt: null, sampledAt: 800 },
      { key: "claude", provider: "claude-code", label: "Claude", plan: "saved", usedWeeklyPct: null, remainWeeklyPct: null, resetWeeklyAt: 1000, sampledAt: 800 },
      { key: "gemini", provider: "antigravity-cli", label: "Gemini", plan: null, usedWeeklyPct: null, remainWeeklyPct: null, resetWeeklyAt: null, sampledAt: null },
      { key: "grok", provider: "grok-cli", label: "Grok", plan: "SuperGrok", usedWeeklyPct: 91.34, remainWeeklyPct: 8.7, resetWeeklyAt: 3000, sampledAt: 900 },
    ] });
  });

  it("uses the log when Grok has no saved sample", async () => {
    const { app } = router([sample("claude-code", null, 2000)]);
    const response = await app.request("/limits/latest");
    expect((await response.json()).providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "claude", remainWeeklyPct: null }),
      expect.objectContaining({ key: "grok", remainWeeklyPct: 8.7 }),
    ]));
  });

  it("keeps saved Grok when its observation is newer", async () => {
    const { app } = router([sample("grok-cli", 100, 2000)], { ...liveGrok, observedAtSec: 700 });
    const response = await app.request("/limits/latest");
    expect((await response.json()).providers[3]).toMatchObject({ key: "grok", remainWeeklyPct: 0, sampledAt: 800 });
  });

  it("uses saved Grok when the log is unavailable and caps percentage conversion", async () => {
    const { app } = router([
      sample("codex-cli", -1, 2000),
      sample("claude-code", 101, 2000),
      sample("grok-cli", 1, 2000),
    ], null);
    const response = await app.request("/limits/latest");
    expect((await response.json()).providers.map((quota: { remainWeeklyPct: number | null }) => quota.remainWeeklyPct))
      .toEqual([100, 0, null, 99]);
  });
});
