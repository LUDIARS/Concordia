import { describe, expect, it } from "vitest";
import {
  buildStatusReportGuidance,
  describeRunStatusForQuery,
  hasCompletionOutcome,
  isTerminalDelegationStatus,
  resolveCompletionEvidencePolicy,
} from "./status-report-policy.js";

describe("describeRunStatusForQuery", () => {
  it.each(["pending", "spawned", "running", "blocked"])("reports %s as correctable", (status) => {
    expect(describeRunStatusForQuery({ id: "r1", status, prompt_file_path: "p.md" } as never)).toMatchObject({
      run_id: "r1", status, terminal: false, correctable: true, prompt_file_path: "p.md",
    });
  });

  it.each(["completed", "failed"])("reports %s as terminal and not correctable", (status) => {
    expect(describeRunStatusForQuery({ id: "r1", status, prompt_file_path: "" } as never)).toMatchObject({
      status, terminal: true, correctable: false, prompt_file_path: null,
    });
  });
});

describe("isTerminalDelegationStatus", () => {
  it("only treats completed and failed as terminal", () => {
    expect(isTerminalDelegationStatus("completed")).toBe(true);
    expect(isTerminalDelegationStatus("failed")).toBe(true);
    expect(isTerminalDelegationStatus("running")).toBe(false);
    expect(isTerminalDelegationStatus(null)).toBe(false);
  });
});

describe("resolveCompletionEvidencePolicy", () => {
  it("checks every delegation and keeps branch evidence for implementation runs", () => {
    for (const category of ["employee", "freelancer", "test-qa", null, undefined]) {
      expect(resolveCompletionEvidencePolicy({ category, reviewOnly: false })).toEqual({
        checked: true, branchRequired: true, outcomeRequired: false,
      });
    }
  });

  it("waives only branch evidence for parttimers and review-only templates", () => {
    const waived = { checked: true, branchRequired: false, outcomeRequired: true };
    expect(resolveCompletionEvidencePolicy({ category: "parttimer", reviewOnly: false })).toEqual(waived);
    expect(resolveCompletionEvidencePolicy({ category: "employee", reviewOnly: true })).toEqual(waived);
  });
});

describe("hasCompletionOutcome", () => {
  it("requires non-blank result or detail", () => {
    expect(hasCompletionOutcome({})).toBe(false);
    expect(hasCompletionOutcome({ result: " ", detail: null })).toBe(false);
    expect(hasCompletionOutcome({ detail: "done" })).toBe(true);
  });
});

describe("buildStatusReportGuidance", () => {
  it("names GET for queries and states that terminal POSTs cannot be corrected", () => {
    const text = buildStatusReportGuidance("/v1/delegation/runs/r1/status").join("\n");
    expect(text).toContain("GET /v1/delegation/runs/r1/status");
    expect(text).toContain("POST /v1/delegation/runs/r1/status");
    expect(text).toContain("訂正できません");
  });
});
