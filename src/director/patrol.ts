/**
 * @implements spec/feature/director-patrol.md §1
 *
 * Director 巡回の計画 (純関数)。
 *
 * 30 分ごとにチーム単位で呼ばれ、director case の step 状態と delegation run の
 * 現在値から「どの step を進め、どの step を起動し、何を人間へ上げるか」を決める。
 * LLM を呼ばない決定的な計画であり、副作用 (repo 更新・invoke・カード投稿) は
 * patrol-runtime 側が持つ。run / PR の正本は複製せず、参照 (run id) だけを扱う。
 */

import type { DirectorCase, DirectorStep } from "./types.js";

/** 巡回が参照する delegation run の最小ビュー。 */
export interface PatrolRunView {
  id: string;
  status:
    | "queued"
    | "launching"
    | "pending"
    | "spawned"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "spawn_failed";
}

export interface PatrolCaseView {
  case: DirectorCase;
  steps: DirectorStep[];
}

export interface PatrolLimits {
  /** case あたりの起動済み run 数の予算 (spec §1.2、既定 10)。 */
  maxRunsPerCase: number;
  /** チームの同時実行 step 数の上限 (既定 1)。 */
  maxActivePerTeam: number;
  /** 1 tick で新規起動する step 数の上限 (既定 1)。 */
  maxLaunchesPerTick: number;
}

export const DEFAULT_PATROL_LIMITS: PatrolLimits = {
  maxRunsPerCase: 10,
  maxActivePerTeam: 1,
  maxLaunchesPerTick: 1,
};

export type PatrolEscalationReason =
  | "run-failed"
  | "launch-failed"
  | "budget-exhausted"
  | "run-missing"
  /** runtime 側の起動時にだけ出る: 対象リポをチーム repos から解決できない。 */
  | "repo-unresolved";

export type PatrolAction =
  | { type: "advance"; caseId: string; stepId: string }
  | { type: "block"; caseId: string; stepId: string; note: string }
  | { type: "launch"; caseId: string; stepId: string }
  /**
   * 人間へ上げる事由。`stepId` は事由の対象 step が特定できるときだけ入る
   * (予算超過・リポ未解決は case 単位なので null)。問診セッションの冪等キーは
   * これを subject に使う (director-inquiry-session.md §2)。
   */
  | {
    type: "escalate";
    caseId: string;
    reason: PatrolEscalationReason;
    detail: string;
    stepId?: string | null;
  };

/** 巡回が起動を担う step 種別。plan/decompose/review/confirm は他フローの持ち場。 */
const LAUNCHABLE_KINDS: ReadonlySet<DirectorStep["kind"]> = new Set(["delegate", "implement"]);

/** run がこの status なら終局。それ以外は実行中扱いでスロットを占有する。 */
const TERMINAL_RUN_STATUSES: ReadonlySet<PatrolRunView["status"]> = new Set([
  "completed",
  "failed",
  "spawn_failed",
]);

export interface PatrolPlanInput {
  cases: PatrolCaseView[];
  findRun: (runId: string) => PatrolRunView | null;
  limits?: Partial<PatrolLimits>;
}

/**
 * 1 チーム分の巡回計画を返す。
 *
 * 返り値の順序は「反映 → 起動 → エスカレーション」。呼び出し側は順に適用すれば、
 * 同一 tick 内で完了反映により空いたスロットを新規起動に使える。
 */
export function planTeamPatrol(input: PatrolPlanInput): PatrolAction[] {
  const limits: PatrolLimits = { ...DEFAULT_PATROL_LIMITS, ...input.limits };
  const advances: PatrolAction[] = [];
  const escalations: PatrolAction[] = [];
  const completedStepIds = new Set<string>();
  let activeCount = 0;

  // ── 反映 (reconcile): active step の参照先 run を突き合わせる ──────────
  for (const view of input.cases) {
    for (const step of view.steps) {
      if (step.status !== "active") continue;
      if (!LAUNCHABLE_KINDS.has(step.kind) || !step.delegation_run_id) {
        // 巡回対象外の kind と run id の無い手動進行も、チームの実行枠は占有する。
        activeCount += 1;
        continue;
      }
      const run = input.findRun(step.delegation_run_id);
      if (!run) {
        advances.push({
          type: "block",
          caseId: step.case_id,
          stepId: step.id,
          note: `delegation run ${step.delegation_run_id} not found`,
        });
        escalations.push({
          type: "escalate",
          caseId: step.case_id,
          reason: "run-missing",
          stepId: step.id,
          detail: `step「${step.title}」の委託 run (${step.delegation_run_id}) が見つかりません。`,
        });
        continue;
      }
      if (run.status === "completed") {
        advances.push({ type: "advance", caseId: step.case_id, stepId: step.id });
        completedStepIds.add(step.id);
        continue;
      }
      if (TERMINAL_RUN_STATUSES.has(run.status)) {
        advances.push({
          type: "block",
          caseId: step.case_id,
          stepId: step.id,
          note: `delegation run ${run.id} ${run.status}`,
        });
        escalations.push({
          type: "escalate",
          caseId: step.case_id,
          reason: "run-failed",
          stepId: step.id,
          // run.error は資格情報・ローカルパス等を含み得るためカードへ複製しない。
          detail: `step「${step.title}」の委託 run (${run.id}) が ${run.status} で終わりました。詳細は内部の run 記録を確認してください。`,
        });
        continue;
      }
      activeCount += 1;
    }
  }

  // ── 検出 (detect): 実行可能な次 step を古い case から拾う ──────────────
  const launches: PatrolAction[] = [];
  const ordered = [...input.cases].sort(
    (a, b) => a.case.created_at - b.case.created_at || a.case.id.localeCompare(b.case.id),
  );
  for (const view of ordered) {
    if (launches.length >= limits.maxLaunchesPerTick) break;
    if (activeCount + launches.length >= limits.maxActivePerTeam) break;
    const projectedSteps = view.steps.map((step) =>
      completedStepIds.has(step.id) ? { ...step, status: "completed" as const } : step);
    const candidate = nextExecutableStep(projectedSteps);
    if (!candidate) continue;
    const launched = view.steps.filter((step) => step.delegation_run_id != null).length;
    if (launched >= limits.maxRunsPerCase) {
      escalations.push({
        type: "escalate",
        caseId: view.case.id,
        reason: "budget-exhausted",
        detail: `case「${view.case.title}」は起動済み run が予算 (${limits.maxRunsPerCase}) に達しています。予算の引き上げか case の整理が必要です。`,
      });
      continue;
    }
    launches.push({ type: "launch", caseId: view.case.id, stepId: candidate.id });
  }

  return [...advances, ...launches, ...escalations];
}

/**
 * sequence 順で先行 step がすべて completed / cancelled の、最初の pending
 * delegate / implement step。先行に blocked / active が残る case は候補にしない。
 * pending なのに run 参照を持つ step は異常形として起動しない (assign ガードの
 * `delegation_run_id IS NULL` と矛盾し、run だけ孤立起動してしまうため)。
 */
export function nextExecutableStep(steps: readonly DirectorStep[]): DirectorStep | null {
  const ordered = [...steps].sort((a, b) => a.sequence - b.sequence);
  for (const step of ordered) {
    if (step.status === "completed" || step.status === "cancelled") continue;
    if (
      step.status === "pending"
      && LAUNCHABLE_KINDS.has(step.kind)
      && step.delegation_run_id == null
    ) return step;
    return null;
  }
  return null;
}
