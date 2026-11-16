import { describe, expect, it, vi } from "vitest";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import type { SessionRow } from "../shared/types.js";
import {
  createOpenPrCache,
  nextReviewLookupStreak,
  OPEN_PR_CACHE_TTL_MS,
  openPrForSession,
  REVIEW_LOOKUP_GIVE_UP_TICKS,
  reviewLookupGivenUp,
  reviewLookupGiveUpNote,
} from "./review-status-source.js";

function pr(patch: Partial<RevisorLocalPr>): RevisorLocalPr {
  return { id: "p", number: 1, repository: "LUDIARS/Concordia", headRef: "feat/x", status: "open", checkStatus: "running", sessionId: null, ...patch } as RevisorLocalPr;
}

const session = { id: "s", repo_origin: "https://github.com/LUDIARS/Concordia.git", branch: "feat/x" } as SessionRow;

describe("review status source", () => {
  it("shares one open listing within the TTL, drops settled rows, and does not cache failures", async () => {
    let now = 0;
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce([pr({ number: 1 }), pr({ number: 2, status: "merged" })])
      .mockResolvedValueOnce([]);
    const cache = createOpenPrCache(list, () => now);
    await expect(cache.read()).rejects.toThrow("timeout");
    const [first, second] = await Promise.all([cache.read(), cache.read()]);
    expect(first.map((row) => row.number)).toEqual([1]);
    expect(second).toBe(first);
    now += OPEN_PR_CACHE_TTL_MS - 1;
    expect(await cache.read()).toBe(first);
    now += 1;
    expect(await cache.read()).toEqual([]);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("narrows to the session's own PR by session id first, then repository and branch", () => {
    const own = pr({ number: 7, sessionId: "s", headRef: "other" });
    const byBranch = pr({ number: 8 });
    expect(openPrForSession([byBranch, own], session)?.number).toBe(7);
    expect(openPrForSession([byBranch], session)?.number).toBe(8);
    expect(openPrForSession([pr({ headRef: "feat/y" })], session)).toBeNull();
  });

  it("counts consecutive failed ticks and gives up after the limit", () => {
    let streak = 0;
    for (let i = 0; i < REVIEW_LOOKUP_GIVE_UP_TICKS; i += 1) streak = nextReviewLookupStreak(streak, "failed");
    expect(nextReviewLookupStreak(streak, null)).toBe(streak);
    expect(reviewLookupGivenUp(streak)).toBe(true);
    expect(reviewLookupGivenUp(streak - 1)).toBe(false);
    expect(nextReviewLookupStreak(streak, "ok")).toBe(0);
    expect(reviewLookupGiveUpNote(3)).toBe("審査状況を 3 巡回続けて確認できないため無活動基準で判定");
  });
});
