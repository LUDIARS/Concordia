import { describe, expect, it } from "vitest";
import { formatTokens, renderTeamCostReport } from "./team-cost-report.js";

describe("formatTokens", () => {
  it("scales to k / M and treats missing cost as zero", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(-5)).toBe("0 tokens");
    expect(formatTokens(940)).toBe("940 tokens");
    expect(formatTokens(12_400)).toBe("12.4k tokens");
    expect(formatTokens(3_500_000)).toBe("3.50M tokens");
  });
});

describe("renderTeamCostReport", () => {
  it("reports the session cost against the team total for the day", () => {
    const text = renderTeamCostReport({
      teamName: "GLab",
      sessionLabel: "感想投稿の実装",
      sessionCostTokens: 25_000,
      teamTodayCostTokens: 100_000,
      teamTodaySessionCount: 4,
    });
    expect(text).toContain("**GLab** セッション終了");
    expect(text).toContain("感想投稿の実装");
    expect(text).toContain("25.0k tokens");
    expect(text).toContain("100.0k tokens");
    expect(text).toContain("4 セッション、 うち今回 25%");
  });

  it("does not divide by zero when the team has no recorded cost", () => {
    const text = renderTeamCostReport({
      teamName: "GLab",
      sessionLabel: "claude (abc)",
      sessionCostTokens: 0,
      teamTodayCostTokens: 0,
      teamTodaySessionCount: 1,
    });
    expect(text).toContain("うち今回 0%");
  });
});
