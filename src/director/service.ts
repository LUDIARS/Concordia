import { randomUUID } from "node:crypto";
import { decideInquiry, geniusCategories, type InquiryCategory } from "../inquiry/decision.js";
import type { GeniusCard, GeniusClient } from "../inquiry/genius-client.js";
import { DirectorRepo } from "./repo.js";
import { DEFAULT_PATROL_LIMITS } from "./patrol.js";
import { emitStepChanged } from "./step-events.js";
import type {
  CreateDirectorCaseInput,
  CreateDirectorStepInput,
  DirectorCaseDetail,
  DirectorCase,
  DirectorDecisionKind,
  DirectorDecisionRecord,
  DirectorIssueSignals,
  DirectorStep,
  DirectorStepSummary,
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
    onPlanApproved?: (directorCase: DirectorCase, step: DirectorStep, plan: DirectorDecisionRecord) => void;
    onPlanRevisionRequested?: (
      directorCase: DirectorCase,
      step: DirectorStep,
      plan: DirectorDecisionRecord,
      instruction: string,
    ) => void;
    onPlanDiscarded?: (directorCase: DirectorCase, step: DirectorStep, plan: DirectorDecisionRecord) => void;
    /**
     * Decision Request が ask_human で確定し工程を止めたときに呼ぶ (設問カード束ね投稿用)。
     * plan 提出由来の ask_human (設計カード経路) では呼ばない。
     */
    onAskHuman?: (directorCase: DirectorCase, step: DirectorStep, decision: DirectorDecisionRecord) => void;
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
      session_id: input.session_id ?? null,
      team_id: input.team_id ?? null,
      created_at: now,
      updated_at: now,
    }, steps);
  }

  getCase(id: string): DirectorCaseDetail | null {
    return this.deps.repo.findCaseDetail(id);
  }

  /**
   * @implements spec/feature/director-inquiry-session.md §3
   * 問診 triggered_by の subject (case id / step id) を所有 case へ解決する。
   */
  resolveCaseIdForInquirySubject(subject: string): string | null {
    return this.deps.repo.findCase(subject)?.id
      ?? this.deps.repo.findStep(subject)?.case_id
      ?? null;
  }

  /**
   * 既存 case へ step を 1 件追加する (spec/feature/director-workflow.md §3)。
   * タスク整理が Memoria の実行可能タスクを巡回 (director-patrol) の実行単位へ
   * 落とすための入口。sequence は repo が末尾採番する。
   */
  appendStep(input: { case_id: string; step: CreateDirectorStepInput }): DirectorStep {
    const now = this.now();
    const appended = this.deps.repo.appendStep({
      id: id("dst"),
      case_id: input.case_id,
      kind: input.step.kind,
      title: input.step.title,
      status: "pending",
      task_path: input.step.task_path ?? null,
      delegation_run_id: input.step.delegation_run_id ?? null,
      local_pr_id: input.step.local_pr_id ?? null,
      confirm_run_id: input.step.confirm_run_id ?? null,
      handoff_note: input.step.handoff_note ?? null,
      created_at: now,
      updated_at: now,
    });
    if (!appended) throw new DirectorNotFoundError("director case not found");
    return appended;
  }

  /** 一覧 (kanban) 用の read model。 decisions は含めず case + steps だけ返す。 */
  listCases(filter: { team_id?: string; limit?: number } = {}): Array<{ case: DirectorCase; steps: DirectorStepSummary[] }> {
    return this.deps.repo.listCasesWithSteps({ teamId: filter.team_id, limit: filter.limit });
  }

  /** @implements spec/feature/director-issue-scout.md §1 */
  issueSignals(input: { team_id: string; days: number }): DirectorIssueSignals {
    const generatedAt = this.now();
    return {
      team_id: input.team_id,
      days: input.days,
      generated_at: generatedAt,
      ...this.deps.repo.issueSignals({
        teamId: input.team_id,
        days: input.days,
        now: generatedAt,
        maxRunsPerCase: DEFAULT_PATROL_LIMITS.maxRunsPerCase,
      }),
    };
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
    emitStepChanged({
      step: updated,
      previousStatus: step.status,
      previousHandoffNote: step.handoff_note,
      now: this.now,
    });
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
    if (shouldBlock) {
      const directorCase = this.deps.repo.findCase(input.case_id);
      if (directorCase) this.deps.onAskHuman?.(directorCase, resolvedStep, savedRecord);
    }
    return { decision: savedRecord, step: resolvedStep };
  }

  submitPlan(input: { case_id: string; step_id: string; markdown: string; md_ref?: string | null }): { decision: DirectorDecisionRecord; step: DirectorStep } {
    const step = this.requireCaseStep(input.case_id, input.step_id);
    if (step.kind !== "plan") throw new DirectorTransitionError("step is not plan");
    if (step.status === "completed" || step.status === "cancelled") {
      throw new DirectorTransitionError("plan step is closed");
    }
    const acceptance = markdownSection(input.markdown, "受け入れ条件");
    if (!acceptance) throw new DirectorTransitionError("acceptance criteria required");
    const prior = this.deps.repo.listDecisions(input.case_id).filter((decision) => decision.step_id === step.id && decision.plan_version);
    const version = Math.max(0, ...prior.map((decision) => decision.plan_version ?? 0)) + 1;
    const record: DirectorDecisionRecord = { id: id("ddc"), case_id: input.case_id, step_id: step.id, kind: "design", question: `plan v${version}`, facts: [input.markdown], options: ["approve", "revise", "discard"], impact: acceptance, decision: "ask_human", instruction: "プランの承認・修正・破棄を選択してください。", genius_available: false, genius_cards: [], created_at: this.now(), plan_version: version, plan_md_ref: input.md_ref ?? null };
    const decision = this.deps.repo.createDecision(record);
    const blocked = step.status === "blocked" ? step : this.updateStep({ case_id: input.case_id, step_id: step.id, status: "blocked" });
    return { decision, step: blocked };
  }

  decidePlan(input: {
    case_id: string;
    step_id: string;
    action: "approve" | "revise" | "discard";
    version: number;
    instruction?: string;
  }): DirectorStep {
    const step = this.requireCaseStep(input.case_id, input.step_id);
    if (step.kind !== "plan") throw new DirectorTransitionError("step is not plan");
    if (step.status === "completed" || step.status === "cancelled") {
      throw new DirectorTransitionError("plan step is closed");
    }
    const plan = latestSubmittedPlan(this.deps.repo.listDecisions(input.case_id), step.id);
    if (!plan || plan.plan_version !== input.version) {
      throw new DirectorTransitionError("plan version superseded");
    }
    const directorCase = this.deps.repo.findCase(input.case_id);
    if (!directorCase) throw new DirectorNotFoundError("director case not found");
    if (input.action === "discard") {
      const updated = this.updateStep({
        case_id: input.case_id,
        step_id: step.id,
        status: "cancelled",
        handoff_note: "plan-discarded",
      });
      this.deps.onPlanDiscarded?.(directorCase, updated, plan);
      return updated;
    }
    if (input.action === "revise") {
      const instruction = input.instruction?.trim();
      if (!instruction) throw new DirectorTransitionError("revision instruction required");
      const updated = this.updateStep({
        case_id: input.case_id,
        step_id: step.id,
        status: "blocked",
        handoff_note: instruction,
      });
      this.deps.onPlanRevisionRequested?.(directorCase, updated, plan, instruction);
      return updated;
    }
    const updated = this.updateStep({
      case_id: input.case_id,
      step_id: step.id,
      status: "completed",
      handoff_note: "plan-approved",
    });
    this.deps.onPlanApproved?.(directorCase, updated, plan);
    return updated;
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

function latestSubmittedPlan(
  decisions: readonly DirectorDecisionRecord[],
  stepId: string,
): DirectorDecisionRecord | null {
  return decisions
    .filter((decision) => decision.step_id === stepId && decision.plan_version != null)
    .at(-1) ?? null;
}

function markdownSection(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => {
    const match = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    return match?.[1] === heading;
  });
  if (headingIndex < 0) return null;
  const sectionEnd = lines.findIndex((line, index) =>
    index > headingIndex && /^##(?:[ \t]+|$)/.test(line));
  const content = lines
    .slice(headingIndex + 1, sectionEnd < 0 ? undefined : sectionEnd)
    .join("\n")
    .trim();
  return content ? content : null;
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function canTransition(from: DirectorStepStatus, to: DirectorStepStatus): boolean {
  if (from === to) return true;
  // pending → completed は「実態完了」の反映 (spec/feature/director-workflow.md §2):
  // 巡回の外で終わった作業を、証跡を根拠に active を経由せず直接 completed へ落とす。
  if (from === "pending") return to === "active" || to === "blocked" || to === "completed" || to === "cancelled";
  if (from === "active") return to === "blocked" || to === "completed" || to === "cancelled";
  if (from === "blocked") return to === "active" || to === "completed" || to === "cancelled";
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
