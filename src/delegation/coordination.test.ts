import { describe, expect, it } from "vitest";
import {
  buildDelegationInjectText,
  buildDelegationMirrorText,
  buildDelegationStatusNotification,
  resolveDelegationRunIdForSession,
} from "./coordination.js";

describe("delegation coordination pure helpers", () => {
  it("resolves run id from session metadata before pending spawn fallback", () => {
    expect(resolveDelegationRunIdForSession({ metadataRunId: " run-meta ", pendingRunId: "run-pending" }))
      .toBe("run-meta");
    expect(resolveDelegationRunIdForSession({ metadataRunId: null, pendingRunId: " run-pending " }))
      .toBe("run-pending");
    expect(resolveDelegationRunIdForSession({ metadataRunId: "", pendingRunId: null }))
      .toBeNull();
  });

  it("formats terminal status notifications for the parent session", () => {
    const text = buildDelegationStatusNotification(
      { id: "run-1", call_name: "impl-from-design", child_session_id: "child-1" },
      { status: "completed", detail: "tests passed", result: "PR ready" },
    );
    expect(text).toContain("Delegation completed: impl-from-design");
    expect(text).toContain("run_id: run-1");
    expect(text).toContain("child_session_id: child-1");
    expect(text).toContain("result: PR ready");
  });

  it("wraps parent injects and child mirror text with the run id", () => {
    expect(buildDelegationInjectText({ runId: "run-1", text: "continue" }))
      .toBe("[delegation:run-1] Parent instruction\n\ncontinue");
    expect(buildDelegationMirrorText({ runId: "run-1", childSessionId: "child-1", text: "done" }))
      .toBe("[delegation:run-1] child child-1\n\ndone");
  });
});
