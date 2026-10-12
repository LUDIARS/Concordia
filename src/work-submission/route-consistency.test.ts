import { describe, expect, it } from "vitest";
import { mainPushRouteWarning } from "./route-consistency.js";

describe("mainPushRouteWarning", () => {
  it("warns when an allowlisted repository is routed to a PR", () => {
    expect(mainPushRouteWarning({ route: "github-pr", mainPushAllowlisted: true })).toContain("github-pr");
    expect(mainPushRouteWarning({ route: "revisor-local-pr", mainPushAllowlisted: true })).toContain("revisor-local-pr");
  });

  it("is silent when both agree or when only direct-main is set (Castra / Villa)", () => {
    expect(mainPushRouteWarning({ route: "direct-main", mainPushAllowlisted: true })).toBeNull();
    expect(mainPushRouteWarning({ route: "direct-main", mainPushAllowlisted: false })).toBeNull();
    expect(mainPushRouteWarning({ route: "github-pr", mainPushAllowlisted: false })).toBeNull();
  });
});
