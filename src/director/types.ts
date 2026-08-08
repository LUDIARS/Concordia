import type { GeniusCard } from "../inquiry/genius-client.js";
import type { InquiryDecision } from "../inquiry/decision.js";

export const DIRECTOR_STEP_KINDS = [
  "decompose",
  "delegate",
  "implement",
  "review",
  "confirm",
  "complete",
] as const;

export type DirectorStepKind = typeof DIRECTOR_STEP_KINDS[number];

export const DIRECTOR_STEP_STATUSES = [
  "pending",
  "active",
  "blocked",
  "completed",
  "cancelled",
] as const;

export type DirectorStepStatus = typeof DIRECTOR_STEP_STATUSES[number];

export const DIRECTOR_DECISION_KINDS = ["design", "priority", "scope", "authority"] as const;

export type DirectorDecisionKind = typeof DIRECTOR_DECISION_KINDS[number];

export interface DirectorCase {
  id: string;
  title: string;
  goal: string;
  project: string;
  created_at: number;
  updated_at: number;
}

export interface DirectorStep {
  id: string;
  case_id: string;
  sequence: number;
  kind: DirectorStepKind;
  title: string;
  status: DirectorStepStatus;
  task_path: string | null;
  delegation_run_id: string | null;
  local_pr_id: string | null;
  confirm_run_id: string | null;
  handoff_note: string | null;
  created_at: number;
  updated_at: number;
}

export interface DirectorDecisionRecord {
  id: string;
  case_id: string;
  step_id: string;
  kind: DirectorDecisionKind;
  question: string;
  facts: string[];
  options: string[];
  impact: string;
  decision: InquiryDecision;
  instruction: string;
  genius_available: boolean;
  genius_cards: GeniusCard[];
  created_at: number;
}

export interface DirectorCaseDetail {
  case: DirectorCase;
  steps: DirectorStep[];
  decisions: DirectorDecisionRecord[];
}

export interface CreateDirectorStepInput {
  kind: DirectorStepKind;
  title: string;
  task_path?: string | null;
  delegation_run_id?: string | null;
  local_pr_id?: string | null;
  confirm_run_id?: string | null;
  handoff_note?: string | null;
}

export interface CreateDirectorCaseInput {
  title: string;
  goal: string;
  project: string;
  steps: CreateDirectorStepInput[];
}

export interface RequestDirectorDecisionInput {
  case_id: string;
  step_id: string;
  kind: DirectorDecisionKind;
  question: string;
  facts: string[];
  options: string[];
  impact: string;
}
