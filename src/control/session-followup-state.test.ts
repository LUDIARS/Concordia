// @spec セッションの設計・開始確認・実装・調整
import { describe, expect, it } from "vitest";
import { renderSessionFollowup, selectSessionFollowupState, type SessionFollowupSnapshot } from "./session-followup-state.js";
import type { WorkPhaseView } from "../work/session-work-phase.js";

const empty: SessionFollowupSnapshot = { workflow: "revisor", tasks: [], delegations: [], prs: [] };
const phase = (value: WorkPhaseView["phase"]): WorkPhaseView => ({
  phase: value, revision: 1, design_summary: "設計", reason: "状況報告", approval_reference: null, updated_at: 100,
});

describe("phase-aware followup", () => {
  it("keeps start confirmation ahead of active task and review records", () => {
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "in_progress" }], prs: [{ status: "open", checkStatus: "failed" }] }, phase("confirmation"))).toBe("start-confirmation");
  });

  it("does not restart work already owned by a child or under review", () => {
    expect(selectSessionFollowupState({ ...empty, delegations: [{ status: "running" }] }, phase("design"))).toBe("delegation-wait");
    expect(selectSessionFollowupState({ ...empty, prs: [{ status: "open", checkStatus: "running" }] }, phase("implementation"))).toBe("review-wait");
    expect(selectSessionFollowupState({ ...empty, prs: [{ status: "merged", checkStatus: "test_ok" }] }, phase("implementation"))).toBe("completed");
  });

  it.each(["design", "unknown"] as const)("assesses %s before starting pending work", (value) => {
    expect(selectSessionFollowupState({ ...empty, tasks: [{ status: "pending" }] }, phase(value))).toBe("design-assessment");
  });

  it("uses local evidence while clearly reporting missing external review state", () => {
    expect(renderSessionFollowup(undefined, phase("confirmation"))).toContain("state=start-confirmation");
    const text = renderSessionFollowup(undefined, phase("unknown"));
    expect(text).toContain("state=design-assessment");
    expect(text).toContain("審査・委託状態は取得できていません");
    expect(text).toContain("人間の確認待ちは維持");
  });
});
