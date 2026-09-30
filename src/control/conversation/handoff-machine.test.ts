import { describe, expect, it } from "vitest";
import {
  canReturnToPredecessor,
  describeHandoffBlockers,
  evaluateHandoffBlockers,
  HANDOFF_STATES,
  isHandoffInFlight,
  nextHandoffState,
} from "./handoff-machine.js";

const noBlockers = { unansweredQuestions: 0, unfinishedChildRuns: 0, openPullRequests: 0, uncertainInputs: 0, ownerUnknown: false };

describe("handoff state machine", () => {
  it("walks the designed order", () => {
    expect(nextHandoffState("handoff_pending", "package_saved")).toBe("handoff_saved");
    expect(nextHandoffState("handoff_saved", "successor_requested")).toBe("successor_requested");
    expect(nextHandoffState("successor_requested", "successor_ready")).toBe("successor_ready");
    expect(nextHandoffState("successor_ready", "routing_switched")).toBe("routing_switched");
    expect(nextHandoffState("routing_switched", "predecessor_drained")).toBe("predecessor_drained");
  });

  it("rejects skipped steps", () => {
    expect(nextHandoffState("handoff_pending", "routing_switched")).toBeNull();
    expect(nextHandoffState("handoff_saved", "successor_ready")).toBeNull();
  });

  it("allows aborting only before the routing switch", () => {
    for (const state of ["handoff_pending", "handoff_saved", "successor_requested", "successor_ready"] as const) {
      expect(nextHandoffState(state, "abort")).toBe("aborted");
      expect(canReturnToPredecessor(state)).toBe(true);
    }
    expect(nextHandoffState("routing_switched", "abort")).toBeNull();
    expect(canReturnToPredecessor("routing_switched")).toBe(false);
  });

  it("has no exits from terminal states", () => {
    for (const terminal of ["predecessor_drained", "aborted", "failed"] as const) {
      for (const event of ["package_saved", "abort", "fail", "routing_switched"] as const) {
        expect(nextHandoffState(terminal, event)).toBeNull();
      }
      expect(isHandoffInFlight(terminal)).toBe(false);
    }
    expect(HANDOFF_STATES).toHaveLength(8);
  });
});

describe("evaluateHandoffBlockers", () => {
  it("allows a handoff with nothing pending", () => {
    expect(evaluateHandoffBlockers(noBlockers)).toEqual([]);
  });

  it("holds the handoff for each unfinished obligation and explains it", () => {
    const blockers = evaluateHandoffBlockers({
      unansweredQuestions: 1, unfinishedChildRuns: 2, openPullRequests: 1, uncertainInputs: 1, ownerUnknown: true,
    });
    expect(blockers).toEqual(["owner_unknown", "unanswered_question", "unfinished_child_run", "open_pull_request", "uncertain_input"]);
    expect(describeHandoffBlockers(["unanswered_question", "open_pull_request"])).toBe("未回答の質問、審査中またはマージ未確認の PR");
  });
});
