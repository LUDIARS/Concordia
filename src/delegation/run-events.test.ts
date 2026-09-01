import { describe, expect, it, vi } from "vitest";
import { emitDelegationRunChanged } from "./run-events.js";

describe("emitDelegationRunChanged", () => {
  it("emits a provider-neutral run event without a Discord dependency", () => {
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

  it("emits for an unparented scheduled run", () => {
    const emit = vi.fn();
    expect(emitDelegationRunChanged({
      id: "run-1",
      parent_session_id: null,
      status: "queued",
    }, { emit }, () => 123)).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      type: "delegation.run_changed",
      parent_session_id: null,
      run_id: "run-1",
      status: "queued",
      ts: 123,
    });
  });
});
