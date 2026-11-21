import { describe, expect, it } from "vitest";
import {
  availableHumanActions,
  autonomousEvaluationTransition,
  decideIntake,
  humanTransition,
  isAiOnlyEvidence,
  needsHumanAttention,
  ManagementInputError,
  requireSeqs,
  startOfJstDay,
  uncoveredSeqs,
  type ManagementEvent,
  type ManagementRequest,
  type Mission,
} from "./domain.js";

const mission: Mission = {
  id: "m1", name: "CDGD", department_id: null, project_codes: ["Cf"], goal: "試遊の意見を改善へつなぐ",
  allowed_kinds: ["discussion", "investigation"], human_gate_kinds: ["spec_change"], requires_effect_check: true,
  allow_ai_only_evidence: false, autonomous_evaluation: false,
  max_open_requests: 2, daily_request_limit: 3, review_interval_minutes: 60, status: "active",
  token_hash: "h", created_at: 0, updated_at: 0, revision: 1,
};

function event(seq: number, origin: ManagementEvent["origin"]): ManagementEvent {
  return { seq, event_key: `e${seq}`, source: "cf", kind: "comment", project_code: "Cf", target_key: "v1",
    origin, parent_request_id: null, summary: "s", ref_url: null, observed_at: 0, created_at: 0 };
}

const base = { mission, kind: "discussion", project_code: "Cf", evidence: [event(1, "human")], evidenceSeqs: [1],
  sameTargetOpen: null, activeCount: 0, todayCount: 0 };

describe("decideIntake (CC-MGMT-04)", () => {
  it("queues an allowed kind and sends a gated kind to a human", () => {
    expect(decideIntake(base)).toEqual({ kind: "accept", state: "queued" });
    expect(decideIntake({ ...base, kind: "spec_change" })).toEqual({ kind: "accept", state: "waiting_human" });
  });

  it("rejects stopped missions, unknown kinds and out-of-scope projects", () => {
    expect(decideIntake({ ...base, mission: { ...mission, status: "stopped" } })).toMatchObject({ code: "mission_stopped" });
    expect(decideIntake({ ...base, kind: "deploy" })).toMatchObject({ code: "kind_not_allowed" });
    expect(decideIntake({ ...base, project_code: "KD" })).toMatchObject({ code: "project_out_of_scope" });
  });

  it("rejects evidence that the mission cannot see", () => {
    expect(decideIntake({ ...base, evidenceSeqs: [1, 2] })).toMatchObject({ code: "evidence_not_visible" });
  });

  it("rejects requests whose only evidence is AI output (CC-MGMT-INV-06)", () => {
    expect(decideIntake({ ...base, evidence: [event(1, "ai")] })).toMatchObject({ code: "evidence_ai_only" });
    expect(decideIntake({ ...base, evidence: [event(1, "ai"), event(2, "human")], evidenceSeqs: [1, 2] }).kind).toBe("accept");
    expect(isAiOnlyEvidence([event(1, "system")])).toBe(false);
    expect(decideIntake({ ...base, mission: { ...mission, allow_ai_only_evidence: true }, evidence: [event(1, "ai")] }))
      .toEqual({ kind: "accept", state: "queued" });
  });

  it("attaches to an open request on the same target before applying limits", () => {
    const parent = { id: "r0" } as ManagementRequest;
    expect(decideIntake({ ...base, sameTargetOpen: parent, activeCount: 99 })).toEqual({ kind: "attach", parent });
  });

  it("enforces concurrent and daily limits", () => {
    expect(decideIntake({ ...base, activeCount: 2 })).toMatchObject({ code: "limit_open_requests" });
    expect(decideIntake({ ...base, todayCount: 3 })).toMatchObject({ code: "limit_daily" });
  });
});

describe("humanTransition (CC-MGMT-05 / INV-07)", () => {
  it("only lets a human release waiting_human", () => {
    expect(humanTransition("waiting_human", "approve", false)).toBe("queued");
    expect(humanTransition("waiting_human", "reject", false)).toBe("rejected");
    expect(humanTransition("queued", "approve", false)).toBeNull();
  });

  it("separates acceptance from effect confirmation", () => {
    expect(humanTransition("outcome_recorded", "accept", true)).toBe("accepted");
    expect(humanTransition("dispatched", "accept", true)).toBeNull();
    expect(humanTransition("accepted", "effect_confirmed", true)).toBe("effect_confirmed");
    expect(humanTransition("accepted", "effect_not_met", false)).toBeNull();
  });
});

describe("autonomous evaluation (CC-MGMT-05 / INV-07)", () => {
  const enabled = { ...mission, autonomous_evaluation: true };
  const request = { mission_id: mission.id, project_code: "Cf", kind: "discussion", state: "outcome_recorded" } as ManagementRequest;

  it("requires recorded output and opt-in for acceptance", () => {
    expect(autonomousEvaluationTransition(enabled, request, "accept", [])).toBe("accepted");
    expect(autonomousEvaluationTransition(mission, request, "accept", [])).toBeNull();
    expect(autonomousEvaluationTransition(enabled, { ...request, state: "execution_finished" }, "accept", [])).toBeNull();
    expect(autonomousEvaluationTransition(enabled, { ...request, state: "waiting_human" }, "accept", [])).toBeNull();
    expect(autonomousEvaluationTransition({ ...enabled, human_gate_kinds: [request.kind] }, request, "accept", [])).toBeNull();
  });

  it("requires acceptance and an enabled effect check with evidence", () => {
    const accepted = { ...request, state: "accepted" as const };
    expect(autonomousEvaluationTransition(enabled, accepted, "effect_confirmed", [1])).toBe("effect_confirmed");
    expect(autonomousEvaluationTransition(enabled, accepted, "effect_not_met", [1])).toBe("effect_not_met");
    expect(autonomousEvaluationTransition(enabled, accepted, "effect_not_met", [])).toBeNull();
    expect(autonomousEvaluationTransition({ ...enabled, requires_effect_check: false }, accepted, "effect_not_met", [1])).toBeNull();
  });
});

describe("human cards (CC-MGMT-06)", () => {
  it("offers only the actions the state allows", () => {
    expect(availableHumanActions("waiting_human", true)).toEqual(["approve", "reject"]);
    expect(availableHumanActions("outcome_recorded", true)).toEqual(["accept"]);
    expect(availableHumanActions("accepted", true)).toEqual(["effect_confirmed", "effect_not_met"]);
    expect(availableHumanActions("accepted", false)).toEqual([]);
    expect(availableHumanActions("dispatched", true)).toEqual([]);
  });

  it("raises a card for launch failures and human decisions only", () => {
    expect(needsHumanAttention("launch_failed", false)).toBe(true);
    expect(needsHumanAttention("waiting_human", false)).toBe(true);
    expect(needsHumanAttention("queued", true)).toBe(false);
    expect(needsHumanAttention("accepted", false)).toBe(false);
    expect(needsHumanAttention("outcome_recorded", true, true)).toBe(false);
    expect(needsHumanAttention("accepted", true, true)).toBe(false);
    expect(needsHumanAttention("waiting_human", true, true)).toBe(true);
    expect(needsHumanAttention("launch_failed", true, true)).toBe(true);
  });
});

describe("inputs and helpers", () => {
  it("normalizes evidence seqs and rejects invalid ones", () => {
    expect(requireSeqs([3, 1, 3])).toEqual([1, 3]);
    expect(() => requireSeqs([])).toThrow(ManagementInputError);
    expect(() => requireSeqs([0])).toThrow(ManagementInputError);
  });

  it("lists events that have no decision yet (CC-MGMT-INV-04)", () => {
    expect(uncoveredSeqs([1, 2, 3], new Set([1, 3]))).toEqual([2]);
  });

  it("counts the daily limit from JST midnight", () => {
    const jstNoon = Date.UTC(2026, 9, 1, 3, 0, 0);
    expect(startOfJstDay(jstNoon)).toBe(Date.UTC(2026, 8, 30, 15, 0, 0));
  });
});
