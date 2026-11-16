import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { checkInstructionEligibility, type EligibilityProbes, type IneligibleReason } from "./instruction-eligibility.js";

const active = { id: "s1", status: "active", metadata: null } as SessionRow;

function probes(patch: Partial<EligibilityProbes> = {}): EligibilityProbes {
  return {
    isControlSession: () => false,
    isAutoCheckDisabled: () => false,
    hasPendingQuestion: () => false,
    isHumanWaitActive: () => false,
    isWaitingForHumanResponse: () => false,
    isAwaitingAsk: async () => false,
    ...patch,
  };
}

describe("checkInstructionEligibility (CC-CTL-INV-05)", () => {
  it("allows an active session with no human wait", async () => {
    expect(await checkInstructionEligibility(active, probes())).toEqual({ ok: true });
  });

  const refusals: Array<[IneligibleReason, Partial<EligibilityProbes>]> = [
    ["control_session", { isControlSession: () => true }],
    ["auto_check_off", { isAutoCheckDisabled: () => true }],
    ["pending_question", { hasPendingQuestion: () => true }],
    ["human_wait", { isHumanWaitActive: () => true }],
    ["awaiting_human_response", { isWaitingForHumanResponse: () => true }],
    ["ask_marker", { isAwaitingAsk: async (): Promise<boolean | null> => true }],
    ["state_unavailable", { isAwaitingAsk: async (): Promise<boolean | null> => null }],
  ];
  it.each(refusals)("refuses %s", async (reason, patch) => {
    expect(await checkInstructionEligibility(active, probes(patch))).toEqual({ ok: false, reason });
  });

  it("refuses ended or missing sessions", async () => {
    expect(await checkInstructionEligibility(null, probes())).toEqual({ ok: false, reason: "not_active" });
    expect(await checkInstructionEligibility({ ...active, status: "ended" } as SessionRow, probes())).toEqual({ ok: false, reason: "not_active" });
  });

  it("does not send when a wait probe fails", async () => {
    const failing = probes({ hasPendingQuestion: () => { throw new Error("db down"); } });
    expect(await checkInstructionEligibility(active, failing)).toEqual({ ok: false, reason: "state_unavailable" });
  });
});
