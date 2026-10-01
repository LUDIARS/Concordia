import { describe, expect, it } from "vitest";
import { AuthFailureLimiter } from "./auth-failure-limiter.js";

describe("AuthFailureLimiter (CC-MGMT-07)", () => {
  it("limits a remote after the configured failures within the window, per remote", () => {
    let now = 0;
    const limiter = new AuthFailureLimiter(3, 1_000, () => now);
    for (let i = 0; i < 3; i++) limiter.recordFailure("a");
    expect(limiter.isLimited("a")).toBe(true);
    expect(limiter.isLimited("b")).toBe(false);
    now = 1_001;
    expect(limiter.isLimited("a")).toBe(false);
  });

  it("starts a new window after expiry and prunes stale entries", () => {
    let now = 0;
    const limiter = new AuthFailureLimiter(2, 1_000, () => now);
    limiter.recordFailure("a");
    now = 2_000;
    limiter.recordFailure("a");
    expect(limiter.isLimited("a")).toBe(false);
    now = 5_000;
    limiter.prune();
    limiter.recordFailure("a");
    expect(limiter.isLimited("a")).toBe(false);
  });
});
