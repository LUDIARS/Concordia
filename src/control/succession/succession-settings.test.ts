import { describe, expect, it } from "vitest";
import { readSuccessionSettings } from "./succession-settings.js";
import { createSpawnBudget } from "./spawn-budget.js";

describe("readSuccessionSettings (§4.2)", () => {
  it("既定値: 自動引き継ぎ on・1M × 70%・quiet 60s・担当上限 3・依頼文待ち 600s", () => {
    const warnings: string[] = [];
    expect(readSuccessionSettings({}, (m) => warnings.push(m))).toEqual({
      handover: { enabled: true, windowTokens: 1_000_000, thresholdPct: 0.7 },
      repoAgents: { enabled: true, maxAgentsPerParent: 3, briefTimeoutSec: 600 },
      quietSec: 60,
    });
    expect(warnings).toEqual([]);
  });

  it("env で無効化・上書きできる", () => {
    const settings = readSuccessionSettings({
      CONCORDIA_AUTO_HANDOVER: "0",
      CONCORDIA_REPO_AGENTS: "off",
      CONCORDIA_AUTO_HANDOVER_WINDOW_TOKENS: "200000",
      CONCORDIA_AUTO_HANDOVER_PCT: "50",
      CONCORDIA_REPO_AGENTS_MAX: "1",
      CONCORDIA_REPO_AGENTS_BRIEF_TIMEOUT_SEC: "30",
      CONCORDIA_AUTO_SUCCESSION_QUIET_SEC: "5",
    }, () => undefined);
    expect(settings).toEqual({
      handover: { enabled: false, windowTokens: 200_000, thresholdPct: 0.5 },
      repoAgents: { enabled: false, maxAgentsPerParent: 1, briefTimeoutSec: 30 },
      quietSec: 5,
    });
  });

  it("壊れた値は既定値へ倒し warn する", () => {
    const warnings: string[] = [];
    const settings = readSuccessionSettings({ CONCORDIA_AUTO_HANDOVER_PCT: "abc", CONCORDIA_REPO_AGENTS_MAX: "-1" }, (m) => warnings.push(m));
    expect(settings.handover.thresholdPct).toBe(0.7);
    expect(settings.repoAgents.maxAgentsPerParent).toBe(3);
    expect(warnings).toHaveLength(2);
  });
});

describe("createSpawnBudget (§3.2)", () => {
  it("直近 60 秒に 2 件まで、 窓を過ぎると戻る", () => {
    let now = 0;
    const budget = createSpawnBudget(() => now);
    expect([budget.tryTake(), budget.tryTake(), budget.tryTake()]).toEqual([true, true, false]);
    now = 59;
    expect(budget.tryTake()).toBe(false);
    now = 60;
    expect(budget.tryTake()).toBe(true);
  });
});
