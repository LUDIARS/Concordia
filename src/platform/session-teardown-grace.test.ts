import { describe, expect, it } from "vitest";
import { TEARDOWN_RELAY_GRACE_SEC, withinTeardownGrace } from "./session-teardown-grace.js";

describe("withinTeardownGrace", () => {
  const now = 1_784_720_000;

  it("ended 直後 (窓内) は猶予する", () => {
    expect(withinTeardownGrace("ended", now - 5, now)).toBe(true);
    expect(withinTeardownGrace("ended", now - TEARDOWN_RELAY_GRACE_SEC, now)).toBe(true);
  });

  it("lost (teardown 中に sweeper が倒した) も窓内なら猶予する", () => {
    expect(withinTeardownGrace("lost", now - 30, now)).toBe(true);
  });

  it("窓を過ぎた ended は猶予しない", () => {
    expect(withinTeardownGrace("ended", now - TEARDOWN_RELAY_GRACE_SEC - 1, now)).toBe(false);
  });

  it("active / その他 status は対象外", () => {
    expect(withinTeardownGrace("active", now - 5, now)).toBe(false);
    expect(withinTeardownGrace("starting", now - 5, now)).toBe(false);
    expect(withinTeardownGrace(null, now - 5, now)).toBe(false);
  });

  it("ended_at 不明は安全側で猶予しない", () => {
    expect(withinTeardownGrace("ended", null, now)).toBe(false);
    expect(withinTeardownGrace("ended", undefined, now)).toBe(false);
    expect(withinTeardownGrace("ended", Number.NaN, now)).toBe(false);
  });
});
