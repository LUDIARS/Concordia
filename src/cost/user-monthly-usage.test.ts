import { describe, expect, it } from "vitest";
import { userMonthlyUsageRows } from "./user-monthly-usage.js";

describe("userMonthlyUsageRows", () => {
  it("予算の無い人にも今月の消費を出し、 予算のある人は割合も出す (消費の多い順)", () => {
    const rows = userMonthlyUsageRows(
      new Map([
        ["111", { total: 1_200.6, team: 200 }],
        ["222", { total: 3_000, team: 0 }],
      ]),
      [
        { scope: "user", target_id: "111", limit_tokens: 4_000 },
        { scope: "user", target_id: "333", limit_tokens: 100 },
        { scope: "team", target_id: "team_a", limit_tokens: 9_000 },
      ],
      new Map([["user:111", 1_000.6], ["team:team_a", 200]]),
    );
    expect(rows).toEqual([
      { user_id: "222", consumed_tokens: 3_000, team_tokens: 0, budget: null },
      {
        user_id: "111", consumed_tokens: 1_200, team_tokens: 200,
        budget: { limit_tokens: 4_000, consumed_tokens: 1_000, ratio: 0.25, exhausted: false },
      },
      {
        user_id: "333", consumed_tokens: 0, team_tokens: 0,
        budget: { limit_tokens: 100, consumed_tokens: 0, ratio: 0, exhausted: false },
      },
    ]);
  });
});
