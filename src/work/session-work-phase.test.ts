// @spec セッションの設計・開始確認・実装・調整
import { describe, expect, it } from "vitest";
import { readSessionWorkPhase, transitionWorkPhase, WORK_PHASE_KEY, type WorkPhaseSession, type WorkPhaseUpdate } from "./session-work-phase.js";

const session: WorkPhaseSession = { repo_path: "/repo", branch: "feature", current_task: "session phases", metadata: null };
const change: WorkPhaseUpdate = { expected_revision: 0, phase: "confirmation", design_summary: "目的・対象・受入条件", reason: "設計確定" };
const save = (s: WorkPhaseSession, input: WorkPhaseUpdate): WorkPhaseSession => ({
  ...s, metadata: JSON.stringify({ [WORK_PHASE_KEY]: transitionWorkPhase(s, input, 123) }),
});

describe("work phase evidence", () => {
  it("requires human start evidence after design is settled", () => {
    const waiting = save(session, change);
    expect(readSessionWorkPhase(waiting).phase).toBe("confirmation");
    expect(() => save(waiting, { ...change, expected_revision: 1, phase: "implementation" })).toThrow("human_start_confirmation_required");
  });

  it("reuses the existing start instruction for adjustment within the same design", () => {
    const started = save(session, { ...change, phase: "implementation", approval_reference: "人間の開始指示" });
    const adjusted = save(started, { ...change, expected_revision: 1, phase: "adjustment" });
    expect(readSessionWorkPhase(adjusted)).toMatchObject({ phase: "adjustment", revision: 2, approval_reference: "人間の開始指示" });
    expect(() => save(started, { ...change, expected_revision: 1, phase: "implementation", design_summary: "追加範囲" })).toThrow("human_start_confirmation_required");
  });

  it.each([
    { repo_path: "/different" }, { branch: "other" }, { current_task: "different work" },
  ])("does not reuse approval after a binding change: %j", (binding) => {
    const started = save(session, { ...change, phase: "implementation", approval_reference: "元の範囲の指示" });
    const rebound = { ...started, ...binding };
    expect(readSessionWorkPhase(rebound)).toMatchObject({ phase: "unknown", revision: 1, approval_reference: null });
    expect(() => save(rebound, { ...change, expected_revision: 1, phase: "implementation" })).toThrow("human_start_confirmation_required");
  });

  it("clears start evidence when returning to design or confirmation", () => {
    const started = save(session, { ...change, phase: "implementation", approval_reference: "開始指示" });
    for (const phase of ["design", "confirmation"] as const) {
      const waiting = save(started, { ...change, expected_revision: 1, phase });
      expect(readSessionWorkPhase(waiting).approval_reference).toBeNull();
      expect(() => save(waiting, { ...change, expected_revision: 2, phase: "implementation" })).toThrow("human_start_confirmation_required");
    }
  });

  it("rejects unsettled design, adjustment before implementation, and stale reports", () => {
    expect(() => save(session, { ...change, design_summary: "" })).toThrow("design_summary_required");
    expect(() => save(session, { ...change, phase: "adjustment", approval_reference: "指示" })).toThrow("implementation_record_required");
    expect(() => save(save(session, change), change)).toThrow("work_phase_revision_conflict");
  });

  it.each([null, "{", "null", JSON.stringify({ [WORK_PHASE_KEY]: { phase: "implementation" } })])("never treats corrupt or absent records as approval", (metadata) => {
    expect(readSessionWorkPhase({ ...session, metadata })).toMatchObject({ phase: "unknown", approval_reference: null });
  });
});
