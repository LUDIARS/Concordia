import type { IntakeInput, IntakeVerdict } from "./domain-types.js";

export default {
  post(result: IntakeVerdict, input: IntakeInput): boolean {
    const { mission, kind, project_code, evidence, evidenceSeqs } = input;
    const eligible = mission.status === "active" && mission.project_codes.includes(project_code)
      && (mission.allowed_kinds.includes(kind) || mission.human_gate_kinds.includes(kind))
      && evidence.length === evidenceSeqs.length;
    const aiOnly = evidence.length > 0 && evidence.every(({ origin }) => origin === "ai");
    const refusedForOrigin = result.kind === "reject" && result.code === "evidence_ai_only";
    if (eligible && aiOnly && mission.allow_ai_only_evidence && !input.sameTargetOpen
      && input.activeCount < mission.max_open_requests && input.todayCount < mission.daily_request_limit) {
      const expected = mission.human_gate_kinds.includes(kind) ? "waiting_human" : "queued";
      return result.kind === "accept" && result.state === expected;
    }
    return refusedForOrigin === (eligible && aiOnly && !mission.allow_ai_only_evidence);
  },
};
