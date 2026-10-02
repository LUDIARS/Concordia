import { describe, expect, it } from "vitest";
import {
  budgetNoticeText,
  evaluateBudget,
  localMonthKey,
  localMonthRange,
  sameSubject,
  subjectForLaunch,
  subjectForSession,
} from "./usage-budget.js";

describe("subjectForLaunch / subjectForSession", () => {
  it("チームで起動したらチーム、 それ以外は依頼者 (片方だけ)", () => {
    expect(subjectForLaunch({ teamId: "team_a", requesterUserId: "123456789" })).toEqual({ scope: "team", targetId: "team_a" });
    expect(subjectForLaunch({ teamId: null, requesterUserId: "123456789" })).toEqual({ scope: "user", targetId: "123456789" });
    expect(subjectForLaunch({ teamId: null, requesterUserId: null })).toBeNull();
    expect(subjectForLaunch({ teamId: null, requesterUserId: "not-an-id" })).toBeNull();
  });

  it("起動済みセッションは team_id と依頼者の記録から決める", () => {
    expect(subjectForSession({ team_id: null, metadata: JSON.stringify({ discord_requester_user_id: "123456789" }) }))
      .toEqual({ scope: "user", targetId: "123456789" });
    expect(subjectForSession({ team_id: "team_a", metadata: "{broken" })).toEqual({ scope: "team", targetId: "team_a" });
    expect(subjectForSession({ metadata: null })).toBeNull();
    expect(sameSubject({ scope: "user", targetId: "1" }, { scope: "user", targetId: "1" })).toBe(true);
    expect(sameSubject(null, { scope: "user", targetId: "1" })).toBe(false);
  });
});

describe("localMonthRange / localMonthKey", () => {
  it("local の暦月で区切る", () => {
    const now = new Date(2026, 9, 15, 12).getTime();
    expect(localMonthRange(now)).toEqual([new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime()]);
    expect(localMonthKey(now)).toBe("2026-10");
    expect(localMonthKey(new Date(2026, 11, 31, 23).getTime())).toBe("2026-12");
  });
});

describe("evaluateBudget", () => {
  it("80% で通知、 100% で使い切り", () => {
    expect(evaluateBudget(799, 1_000)).toMatchObject({ exhausted: false, reached: null });
    expect(evaluateBudget(800, 1_000)).toMatchObject({ exhausted: false, reached: 80 });
    expect(evaluateBudget(1_000, 1_000)).toMatchObject({ exhausted: true, reached: 100 });
  });

  it("上限 0 は使えない", () => {
    expect(evaluateBudget(0, 0)).toMatchObject({ exhausted: true, reached: 100 });
  });

  it("知らせの文面に使用量を入れる", () => {
    expect(budgetNoticeText({ scope: "user", targetId: "1" }, evaluateBudget(1_500, 1_500))).toContain("使い切りました (1,500 / 1,500");
    expect(budgetNoticeText({ scope: "team", targetId: "t" }, evaluateBudget(800, 1_000))).toContain("チームの今月の予算の 80%");
  });
});
