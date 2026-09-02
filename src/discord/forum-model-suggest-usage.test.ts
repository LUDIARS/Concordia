import { describe, expect, it, vi } from "vitest";
import { collectForumModelUsage } from "./forum-model-suggest-usage.js";

describe("collectForumModelUsage", () => {
  it("Codex / Claude / Fable の週間窓をサジェスト用の形へ写像する", async () => {
    const usage = await collectForumModelUsage({
      log: { warn: vi.fn() },
      fetchCodex: async () => ({
        used5h: 10,
        usedWeekly: 20,
        reset5hAt: 1_700_000_100,
        resetWeeklyAt: 1_700_086_400,
        plan: "pro",
      }),
      fetchClaude: async () => ({
        plan: "max",
        fiveHour: null,
        sevenDay: { utilization: 40, resetsAtSec: 1_700_172_800 },
        sevenDaySonnet: null,
        sevenDayOpus: null,
        sevenDayFable: { utilization: 30, resetsAtSec: 1_700_172_800 },
        extraCredit: {
          isEnabled: false,
          monthlyLimit: null,
          usedCredits: null,
          utilization: null,
          currency: null,
        },
        fetchedAt: 1_700_000_000,
      }),
    });

    expect(usage).toEqual({
      codexWeekly: { usedPct: 20, resetAtSec: 1_700_086_400 },
      claudeWeekly: { usedPct: 40, resetAtSec: 1_700_172_800 },
      fableUsedPct: 30,
    });
  });

  it("取得失敗は null の残量として扱う", async () => {
    const usage = await collectForumModelUsage({
      log: { warn: vi.fn() },
      fetchCodex: async () => { throw new Error("codex unavailable"); },
      fetchClaude: async () => { throw new Error("claude unavailable"); },
    });

    expect(usage).toEqual({ codexWeekly: null, claudeWeekly: null, fableUsedPct: null });
  });
});
