import { describe, expect, it, vi } from "vitest";
import { emitDelegationRunChanged } from "./run-events.js";

describe("emitDelegationRunChanged", () => {
  it("emits a provider-neutral parent refresh event without a Discord dependency", () => {
    const emit = vi.fn();
    expect(emitDelegationRunChanged({
      id: "run-1",
      parent_session_id: "parent-1",
      status: "running",
    }, { emit }, () => 123)).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      type: "delegation.run_changed",
      parent_session_id: "parent-1",
      run_id: "run-1",
      status: "running",
      ts: 123,
    });
  });

  it("does not emit for an unparented run", () => {
    const emit = vi.fn();
    expect(emitDelegationRunChanged({
      id: "run-1",
      parent_session_id: null,
      status: "queued",
    }, { emit }, () => 123)).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
