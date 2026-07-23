import { describe, expect, it } from "vitest";
import { resolveDelegationParentSessionId } from "./delegation-parent-session.js";

describe("resolveDelegationParentSessionId", () => {
  it("inherits CONCORDIA_SESSION_ID when the caller omitted parent_session_id", () => {
    expect(resolveDelegationParentSessionId(undefined, " lictor-parent ")).toBe("lictor-parent");
  });

  it("keeps an explicit parent_session_id instead of the environment fallback", () => {
    expect(resolveDelegationParentSessionId(" explicit-parent ", "lictor-parent")).toBe(
      "explicit-parent",
    );
  });

  it("omits the field when neither source is usable", () => {
    expect(resolveDelegationParentSessionId(" ", " ")).toBeUndefined();
  });
});
