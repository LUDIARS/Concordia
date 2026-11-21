import type { EvaluationAction, ManagementRequest, Mission, RequestState } from "./domain-types.js";

export default {
  post(result: RequestState | null, mission: Mission, request: ManagementRequest, action: EvaluationAction, evidence: readonly number[]): boolean {
    if (mission.status !== "active" || !mission.autonomous_evaluation || request.mission_id !== mission.id
      || !mission.project_codes.includes(request.project_code) || !mission.allowed_kinds.includes(request.kind)
      || mission.human_gate_kinds.includes(request.kind)) return result === null;
    if (action === "accept") return result === (request.state === "outcome_recorded" ? "accepted" : null);
    const effectCanBeEvaluated = request.state === "accepted" && mission.requires_effect_check && evidence.length > 0;
    return result === (effectCanBeEvaluated ? action : null);
  },
};
