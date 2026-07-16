import { describe, expect, it } from "vitest";
import { delegationTerminalUpdate, parseCodexSessionEvent } from "./concordia-codex-worker-events.mjs";

describe("parseCodexSessionEvent", () => {
  it("reads the current thread.started event", () => {
    expect(parseCodexSessionEvent({ type: "thread.started", thread_id: "thread-123" }))
      .toEqual({ sessionId: "thread-123", meta: {} });
  });

  it("keeps compatibility with legacy session_meta", () => {
    expect(parseCodexSessionEvent({
      type: "session_meta",
      payload: { session_id: "session-123", cwd: "E:/repo" },
    })).toEqual({ sessionId: "session-123", meta: { session_id: "session-123", cwd: "E:/repo" } });
  });

  it("ignores unrelated or incomplete events", () => {
    expect(parseCodexSessionEvent({ type: "item.completed" })).toBeNull();
    expect(parseCodexSessionEvent({ type: "thread.started" })).toBeNull();
  });
});

describe("delegationTerminalUpdate", () => {
  it("completes a registered successful run", () => {
    expect(delegationTerminalUpdate(0, true)).toEqual({ status: "completed" });
  });

  it("fails instead of leaving an unregistered run spawned forever", () => {
    expect(delegationTerminalUpdate(0, false)).toMatchObject({ status: "failed" });
    expect(delegationTerminalUpdate(1, true, "boom")).toEqual({
      status: "failed",
      error: "Codex exited with code 1: boom",
    });
  });
});
