import { describe, expect, it } from "vitest";
import {
  BOUNTY_REPORT_STATUSES,
  decideBountyTransition,
  isBeforeAcceptance,
  isBountyReportStatus,
  type BountyReportStatus,
} from "./report-state.js";

const deploy = { kind: "deploy" as const, code: "Cc", hash: "abc123" };
const manual = { kind: "manual" as const, reason: "本番で再現しないことを確認", actor: "900" };

describe("decideBountyTransition (bug-bounty.md §9)", () => {
  it("walks the accepted path up to the deployment", () => {
    const path: BountyReportStatus[] = ["received", "accepted", "fix_pending", "fixing", "fix_submitted"];
    for (let index = 1; index < path.length; index += 1) {
      expect(decideBountyTransition({ from: path[index - 1]!, to: path[index]! })).toEqual({ ok: true });
    }
    expect(decideBountyTransition({ from: "fix_submitted", to: "deployed", deploymentEvidence: deploy })).toEqual({ ok: true });
  });

  it("returns a needs_info report to triage and lets a failed hotfix fall back to fix_pending", () => {
    expect(decideBountyTransition({ from: "received", to: "needs_info" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "needs_info", to: "received" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "fixing", to: "fix_pending" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "fix_submitted", to: "fix_pending" }).ok).toBe(true);
  });

  it("lets a verdict be overturned in both directions (CC-BOUNTY-INV-08)", () => {
    expect(decideBountyTransition({ from: "rejected", to: "accepted" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "duplicate", to: "accepted" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "accepted", to: "rejected" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "fix_pending", to: "duplicate" }).ok).toBe(true);
  });

  it("never treats a submitted or merged PR as the deployment (CC-BOUNTY-INV-09)", () => {
    for (const from of ["fix_pending", "fixing", "fix_submitted"] as const) {
      expect(decideBountyTransition({ from, to: "deployed" }))
        .toEqual({ ok: false, denial: "deployment_evidence_required" });
      expect(decideBountyTransition({ from, to: "deployed", deploymentEvidence: null }).ok).toBe(false);
      expect(decideBountyTransition({ from, to: "deployed", deploymentEvidence: { kind: "deploy", code: "Cc", hash: " " } }).ok)
        .toBe(false);
      expect(decideBountyTransition({ from, to: "deployed", deploymentEvidence: manual })).toEqual({ ok: true });
    }
  });

  it("refuses to skip the fix or to close a report that was not accepted", () => {
    expect(decideBountyTransition({ from: "received", to: "deployed", deploymentEvidence: deploy }))
      .toEqual({ ok: false, denial: "transition_not_allowed" });
    expect(decideBountyTransition({ from: "accepted", to: "deployed", deploymentEvidence: deploy }).ok).toBe(false);
    expect(decideBountyTransition({ from: "received", to: "fix_pending" }).ok).toBe(false);
    expect(decideBountyTransition({ from: "received", to: "received" }).ok).toBe(false);
  });

  it("allows withdrawal only before acceptance and keeps deployed / withdrawn terminal", () => {
    expect(decideBountyTransition({ from: "received", to: "withdrawn" }).ok).toBe(true);
    expect(decideBountyTransition({ from: "needs_info", to: "withdrawn" }).ok).toBe(true);
    for (const from of ["rejected", "duplicate", "accepted", "fix_pending", "fixing", "fix_submitted"] as const) {
      expect(decideBountyTransition({ from, to: "withdrawn" }).ok).toBe(false);
    }
    for (const to of BOUNTY_REPORT_STATUSES) {
      expect(decideBountyTransition({ from: "deployed", to, deploymentEvidence: deploy }).ok).toBe(false);
      expect(decideBountyTransition({ from: "withdrawn", to, deploymentEvidence: deploy }).ok).toBe(false);
    }
  });
});

describe("status helpers", () => {
  it("names the statuses before acceptance", () => {
    expect(BOUNTY_REPORT_STATUSES.filter(isBeforeAcceptance)).toEqual(["received", "needs_info"]);
  });

  it("recognises only declared statuses", () => {
    expect(isBountyReportStatus("fix_submitted")).toBe(true);
    expect(isBountyReportStatus("merged")).toBe(false);
    expect(isBountyReportStatus(null)).toBe(false);
  });
});
