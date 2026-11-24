/**
 * 「動いているセッション」欄のプランと進捗の組み立て (純関数、Cc v5 実装メモ 13)。
 * 既存の正本 (session_task_records・desktop_plan・作業段階・自動確認の記録・Actio の紐付け) を読むだけで、
 * ここで値を作らない。未計測は null (「未計測」と出し 0% にしない)、読めなかった欄は unavailable。
 *
 * @implements spec/feature/control-session.md §13 プランと進捗
 */
import type { SessionPlanState } from "../session-plan/plan-state.js";
import { WORK_PHASE_LABELS, type WorkPhaseView } from "../work/session-work-phase.js";
import type { ControlBoardRowWithLink } from "./session-link.js";

export type StepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  text: string;
  status: StepStatus;
}

export interface LinkedTaskState {
  reference: string;
  status: string;
  state: "current" | "unknown";
}

export type TaskLinksReading =
  | { state: "ok"; items: LinkedTaskState[] }
  | { state: "unavailable" };

export interface SessionPlanView {
  steps: PlanStep[];
  /** デスクトップアプリ / agy のプランの状態 1 行。無ければ null。 */
  desktop_plan_status: string | null;
  work_phase: { phase: WorkPhaseView["phase"]; label: string; design_summary: string };
}

export interface SessionProgressView {
  steps_completed: number;
  steps_total: number;
  /** 自動確認の進捗率 (0〜100)。未計測は null。 */
  followup_rate: number | null;
  tasks: TaskLinksReading;
}

export type SessionWithProgress = ControlBoardRowWithLink & { plan: SessionPlanView; progress: SessionProgressView };

const PLAN_PHASE_LABELS: Record<SessionPlanState["phase"], string> = {
  working: "作業中", summary: "まとめ済み", waiting: "人の回答待ち",
};

/** 自動確認の記録の指紋の末尾 `|rate:<n|none>` (followup-progress.ts) から進捗率を読む。無ければ null。 */
export function parseFollowupRate(fingerprint: string | null | undefined): number | null {
  const match = /\|rate:(\d{1,3}|none)$/.exec(fingerprint ?? "");
  if (!match || match[1] === "none") return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

export function renderDesktopPlanStatus(plan: SessionPlanState | null): string | null {
  if (!plan) return null;
  const recap = plan.summary?.recap ? ` — ${plan.summary.recap.replace(/\s+/g, " ").slice(0, 120)}` : "";
  return `${PLAN_PHASE_LABELS[plan.phase]}${recap}`;
}

export function buildSessionProgress(input: {
  row: ControlBoardRowWithLink;
  steps: readonly PlanStep[];
  desktopPlan: SessionPlanState | null;
  workPhase: WorkPhaseView;
  followupFingerprint: string | null;
  tasks: TaskLinksReading;
}): SessionWithProgress {
  // TodoWrite が無くデスクトップのプランだけのセッションは、プランのステップを出す。
  const steps = input.steps.length > 0
    ? [...input.steps]
    : (input.desktopPlan?.steps ?? []).map((step) => ({ text: step.content, status: step.status }));
  return {
    ...input.row,
    plan: {
      steps,
      desktop_plan_status: renderDesktopPlanStatus(input.desktopPlan),
      work_phase: {
        phase: input.workPhase.phase,
        label: WORK_PHASE_LABELS[input.workPhase.phase],
        design_summary: input.workPhase.design_summary.slice(0, 600),
      },
    },
    progress: {
      steps_completed: steps.filter((step) => step.status === "completed").length,
      steps_total: steps.length,
      followup_rate: parseFollowupRate(input.followupFingerprint),
      tasks: input.tasks,
    },
  };
}
