export type MissionStatus = "active" | "stopped";
export type EventOrigin = "human" | "ai" | "system";
export type DecisionVerdict = "request" | "wait" | "skip" | "investigate" | "attach";
export type RequestState =
  | "waiting_human"
  | "rejected"
  | "queued"
  | "launching"
  | "launch_unknown"
  | "launch_failed"
  | "attached"
  | "dispatched"
  | "execution_finished"
  | "outcome_recorded"
  | "accepted"
  | "effect_confirmed"
  | "effect_not_met";

export interface Mission {
  id: string;
  name: string;
  department_id: string | null;
  project_codes: string[];
  goal: string;
  allowed_kinds: string[];
  human_gate_kinds: string[];
  requires_effect_check: boolean;
  allow_ai_only_evidence: boolean;
  autonomous_evaluation: boolean;
  max_open_requests: number;
  daily_request_limit: number;
  review_interval_minutes: number;
  status: MissionStatus;
  token_hash: string;
  created_at: number;
  updated_at: number;
  revision: number;
}

export interface ManagementEvent {
  seq: number;
  event_key: string;
  source: string;
  kind: string;
  project_code: string;
  target_key: string | null;
  origin: EventOrigin;
  parent_request_id: string | null;
  summary: string;
  ref_url: string | null;
  observed_at: number;
  created_at: number;
}

export interface Decision {
  id: string;
  mission_id: string;
  decision_key: string;
  verdict: DecisionVerdict;
  evidence_seqs: number[];
  rationale: string;
  request_id: string | null;
  created_at: number;
}

export interface ManagementRequest {
  id: string;
  mission_id: string;
  request_key: string;
  kind: string;
  project_code: string;
  target_key: string;
  purpose: string;
  completion_criteria: string;
  evidence_seqs: number[];
  rationale: string;
  state: RequestState;
  attached_to: string | null;
  session_id: string | null;
  spawn_id: string | null;
  launch_deadline_at: number | null;
  outcome_summary: string | null;
  outcome_refs: string[];
  human_note: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
  /** 人間向けカードを配達した revision (CC-MGMT-06)。 */
  delivered_revision: number;
  discord_message_id: string | null;
}

export type IntakeVerdict =
  | { kind: "reject"; code: string; message: string }
  | { kind: "attach"; parent: ManagementRequest }
  | { kind: "accept"; state: "queued" | "waiting_human" };

export interface IntakeInput {
  mission: Mission;
  kind: string;
  project_code: string;
  evidence: readonly ManagementEvent[];
  evidenceSeqs: readonly number[];
  sameTargetOpen: ManagementRequest | null;
  activeCount: number;
  todayCount: number;
}

export type HumanAction = "approve" | "reject" | "accept" | "effect_confirmed" | "effect_not_met";
export type EvaluationAction = Exclude<HumanAction, "approve" | "reject">;
