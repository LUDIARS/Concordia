import type { GeniusCard } from "../inquiry/genius-client.js";
import type { InquiryDecision } from "../inquiry/decision.js";

export const DIRECTOR_STEP_KINDS = [
  "plan",
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
  session_id: string | null;
  team_id: string | null;
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

/** kanban 一覧で公開する最小 step 契約。内部参照や handoff note は含めない。 */
export type DirectorStepSummary = Pick<
  DirectorStep,
  "id" | "sequence" | "kind" | "title" | "status"
>;

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
  plan_version?: number | null;
  plan_md_ref?: string | null;
  /** ask_human 分を束ねた設問カード (discord_pending_questions) の id。未投稿は null。 */
  pending_question_id?: number | null;
  /** 人間の回答 (選択肢テキストまたは自由文)。未回答は null。 */
  human_answer?: string | null;
  human_answered_at?: number | null;
}

export interface DirectorCaseDetail {
  case: DirectorCase;
  steps: DirectorStep[];
  decisions: DirectorDecisionRecord[];
}

/** 課題スカウトに渡す、既存 Director 正本からの読み取り専用 signal 集約。 */
export interface DirectorIssueSignals {
  team_id: string;
  days: number;
  generated_at: number;
  blocked_steps: Array<{
    case_id: string;
    case_title: string;
    step_id: string;
    step_title: string;
    /** patrol が生成した既知事由だけを返す。handoff_note の生文は公開しない。 */
    note: "run-missing" | "run-failed" | null;
    updated_at: number;
  }>;
  stalled_cases: Array<{ case_id: string; title: string; updated_at: number }>;
  budget_exhausted_cases: Array<{ case_id: string; title: string; launched: number }>;
  case_count: number;
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
  session_id?: string | null;
  team_id?: string | null;
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
