import { randomUUID } from "node:crypto";
import { decideInquiry, geniusCategories, type InquiryCategory } from "../inquiry/decision.js";
import type { GeniusCard, GeniusClient } from "../inquiry/genius-client.js";
import { DirectorRepo } from "./repo.js";
import type {
  CreateDirectorCaseInput,
  DirectorCaseDetail,
  DirectorDecisionKind,
  DirectorDecisionRecord,
  DirectorStep,
  DirectorStepStatus,
  RequestDirectorDecisionInput,
} from "./types.js";

export class DirectorNotFoundError extends Error {}

export class DirectorTransitionError extends Error {}

export class DirectorService {
  constructor(private readonly deps: {
    repo: DirectorRepo;
    genius: GeniusClient;
    scoreMin: number;
    now?: () => number;
  }) {}

  createCase(input: CreateDirectorCaseInput): DirectorCaseDetail {
    const now = this.now();
    const caseId = id("dir");
    const steps = input.steps.map((step, index) => ({
      id: id("dst"),
      case_id: caseId,
      sequence: index + 1,
      kind: step.kind,
      title: step.title,
      status: "pending" as const,
      task_path: step.task_path ?? null,
      delegation_run_id: step.delegation_run_id ?? null,
      local_pr_id: step.local_pr_id ?? null,
      confirm_run_id: step.confirm_run_id ?? null,
      handoff_note: step.handoff_note ?? null,
      created_at: now,
      updated_at: now,
    }));
    return this.deps.repo.createCase({
      id: caseId,
      title: input.title,
      goal: input.goal,
      project: input.project,
      created_at: now,
      updated_at: now,
    }, steps);
  }

  getCase(id: string): DirectorCaseDetail | null {
    return this.deps.repo.findCaseDetail(id);
  }

  updateStep(input: {
    case_id: string;
    step_id: string;
    status: DirectorStepStatus;
    handoff_note?: string | null;
  }): DirectorStep {
    const step = this.requireCaseStep(input.case_id, input.step_id);
    if (!canTransition(step.status, input.status)) {
      throw new DirectorTransitionError(`cannot transition ${step.status} to ${input.status}`);
    }
    const updated = this.deps.repo.updateStepStatus({
      id: step.id,
      status: input.status,
      handoff_note: input.handoff_note,
      updated_at: this.now(),
    });
    if (!updated) throw new DirectorNotFoundError("director step not found");
    return updated;
  }

  async requestDecision(input: RequestDirectorDecisionInput): Promise<{ decision: DirectorDecisionRecord; step: DirectorStep }> {
    const step = this.requireCaseStep(input.case_id, input.step_id);
    const cards = await this.deps.genius.query({
      text: renderDecisionContext(input),
      categories: geniusCategories(toInquiryCategory(input.kind)),
      k: 8,
    }).catch(() => null);
    const geniusAvailable = cards !== null;
    const inquiryDecision = cards === null
      ? "self_judge"
      : decideDirectorInquiry(cards, this.deps.scoreMin);
    const guardedFallback = requiresHumanFallback(input.kind) && inquiryDecision === "self_judge";
    const decision = guardedFallback ? "ask_human" : inquiryDecision;
    const record: DirectorDecisionRecord = {
      id: id("ddc"),
      case_id: input.case_id,
      step_id: input.step_id,
      kind: input.kind,
      question: input.question,
      facts: input.facts,
      options: input.options,
      impact: input.impact,
      decision,
      instruction: instructionFor(
        decision,
        cards ?? [],
        this.deps.scoreMin,
        geniusAvailable,
        guardedFallback,
      ),
      genius_available: geniusAvailable,
      genius_cards: cards ?? [],
      created_at: this.now(),
    };
    const savedRecord = this.deps.repo.createDecision(record);
    // Genius 応答待ちの間に工程が進む可能性があるため、保存後に最新状態を読み直す。
    // terminal へ到達済みなら監査記録だけを残し、古い active 状態を根拠に再遷移しない。
    const currentStep = this.requireCaseStep(input.case_id, input.step_id);
    const shouldBlock = decision === "ask_human"
      && currentStep.status !== "completed"
      && currentStep.status !== "cancelled";
    const resolvedStep = shouldBlock && currentStep.status !== "blocked"
      ? this.updateStep({ case_id: input.case_id, step_id: currentStep.id, status: "blocked" })
      : currentStep;
    return { decision: savedRecord, step: resolvedStep };
  }

  private requireCaseStep(caseId: string, stepId: string): DirectorStep {
    if (!this.deps.repo.findCase(caseId)) throw new DirectorNotFoundError("director case not found");
    const step = this.deps.repo.findStep(stepId);
    if (!step || step.case_id !== caseId) throw new DirectorNotFoundError("director step not found");
    return step;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function canTransition(from: DirectorStepStatus, to: DirectorStepStatus): boolean {
  if (from === to) return true;
  if (from === "pending") return to === "active" || to === "blocked" || to === "cancelled";
  if (from === "active") return to === "blocked" || to === "completed" || to === "cancelled";
  if (from === "blocked") return to === "active" || to === "cancelled";
  return false;
}

function toInquiryCategory(kind: DirectorDecisionKind): InquiryCategory {
  if (kind === "priority") return "タスク";
  if (kind === "authority") return "権限";
  return "設計";
}

function requiresHumanFallback(kind: DirectorDecisionKind): boolean {
  return kind === "authority" || kind === "scope";
}

function decideDirectorInquiry(
  cards: readonly GeniusCard[],
  scoreMin: number,
): DirectorDecisionRecord["decision"] {
  const decision = decideInquiry(cards, scoreMin);
  if (decision !== "proceed") return decision;
  return cards.some((card) => card.score >= scoreMin && card.judgment?.trim())
    ? "proceed"
    : "self_judge";
}

function renderDecisionContext(input: RequestDirectorDecisionInput): string {
  return [
    `[Director ${input.kind}] ${input.question}`,
    `事実: ${input.facts.join(" | ") || "未記載"}`,
    `選択肢: ${input.options.join(" | ") || "未記載"}`,
    `影響: ${input.impact}`,
  ].join("\n");
}

function instructionFor(
  decision: DirectorDecisionRecord["decision"],
  cards: readonly GeniusCard[],
  scoreMin: number,
  geniusAvailable: boolean,
  guardedFallback: boolean,
): string {
  if (decision === "proceed") {
    const precedent = cards
      .filter((card) => card.score >= scoreMin && card.judgment?.trim())
      .sort((left, right) => right.score - left.score)[0];
    // decideDirectorInquiry が judgment の存在を必須にしているため、通常ここは必ず値を持つ。
    return precedent?.judgment?.trim() || "Genius の判断を取得できませんでした。通常判断で進めてください。";
  }
  if (decision === "ask_human") {
    if (guardedFallback) {
      return geniusAvailable
        ? "Genius に十分な前例がありません。権限またはスコープの判断は人間の承認を待ってください。"
        : "Genius が利用できません。権限またはスコープの判断は人間の承認を待ってください。";
    }
    return "Genius の判断では人間の承認が必要です。上長の判断を待ってください。";
  }
  return "判断代行 (Genius) が不在または前例不足です。このセッションの通常判断で進めてください。";
}
