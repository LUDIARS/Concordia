/**
 * @implements spec/feature/director-inquiry-session.md §1 §2 §4
 *
 * Director 問診の副作用境界。停滞カウンタの永続化、日次/冪等ガード、delegation 起動、
 * 機械文カードへのフォールバック判定を持つ。通常の巡回工程適用は patrol-runtime.ts の責務。
 */

import { createChildLogger } from "../shared/logger.js";
import {
  inquiryDailyCountPatterns,
  inquiryTriggeredBy,
  judgeStall,
  planInquiries,
  type InquiryCandidate,
  type InquiryLimits,
} from "./inquiry-patrol.js";
import { renderInquiryInstruction } from "./inquiry-instruction.js";
import { nextExecutableStep, type PatrolCaseView, type PatrolRunView } from "./patrol.js";
import type { DirectorCase, DirectorStep } from "./types.js";

const log = createChildLogger("director-inquiry");

export interface InquiryRuntimeTeam {
  id: string;
  slug: string;
}

interface InquiryDirectorPort {
  hasUnansweredAskHumanDecisionsForCase(caseId: string): boolean;
  getStallTicks(caseId: string): number;
  setStallTicks(caseId: string, ticks: number): void;
}

interface InquiryRunRowLike {
  id: string;
  status: PatrolRunView["status"];
}

interface InquiryRunsPort {
  findRun(id: string): InquiryRunRowLike | null;
  findRunByTriggeredBy(triggeredBy: string): InquiryRunRowLike | null;
  countRunsByTriggeredByLike(patterns: readonly string[]): number;
}

interface InquiryDelegationPort {
  invoke(input: {
    call_name: string;
    args: Record<string, unknown>;
    triggered_by?: string;
    options?: Record<string, unknown>;
  }): Promise<{ ok: true; run: { id: string } } | { ok: false; error: string }>;
}

export interface InquiryRuntimeDeps {
  director: InquiryDirectorPort;
  runs: InquiryRunsPort;
  delegationService: InquiryDelegationPort;
  teamRepos: (teamId: string) => string[];
  resolveRepo: (origins: readonly string[], directorCase: DirectorCase) => string | null;
  askCallName: string;
  concordiaUrl: string;
  mentionUserId?: () => string | null;
  limits?: Partial<InquiryLimits>;
  now?: () => number;
}

export interface InquiryRuntime {
  collectStalls(
    cases: PatrolCaseView[],
    staleCases: ReadonlySet<string>,
    candidates: InquiryCandidate[],
  ): void;
  dispatch(
    team: InquiryRuntimeTeam,
    cases: PatrolCaseView[],
    candidates: readonly InquiryCandidate[],
    fallback: (candidate: InquiryCandidate) => void,
  ): Promise<void>;
}

/**
 * 起動済み問診 run のうち、**人間への通知経路が生きていない**終了状態。
 *
 * 問診 run が立ったこと自体は通知ではない。decision を出す前に落ちた run は、
 * 「問診も出ていないし機械文カードも出ていない」= その日の通知が丸ごと消える状態を作る。
 * spec §1 の「起動失敗時は従来の機械文カードが出る (通知が消えない)」を、
 * 起動後に死んだ場合まで広げて担保する。
 *
 * `completed` は除く (decision を出し切った正常終了)。`blocked` も除く —
 * patrol.ts の TERMINAL_RUN_STATUSES と同じ扱いで、停止ではなく再開待ちとみなす。
 */
const DEAD_INQUIRY_RUN_STATUSES: ReadonlySet<PatrolRunView["status"]> = new Set([
  "failed",
  "spawn_failed",
]);

export function createInquiryRuntime(deps: InquiryRuntimeDeps): InquiryRuntime {
  const now = deps.now ?? (() => Date.now());

  function collectStalls(
    cases: PatrolCaseView[],
    staleCases: ReadonlySet<string>,
    candidates: InquiryCandidate[],
  ): void {
    for (const view of cases) {
      if (staleCases.has(view.case.id)) continue;
      const stallTicks = deps.director.getStallTicks(view.case.id);
      const verdict = judgeStall({
        hasOpenWork: view.steps.some(
          (step) => step.status !== "completed" && step.status !== "cancelled",
        ),
        hasExecutableStep: nextExecutableStep(view.steps) != null,
        hasActiveStep: view.steps.some((step) => step.status === "active"),
        stallTicks,
        limits: deps.limits,
      });
      if (verdict.type === "reset") {
        if (stallTicks !== 0) deps.director.setStallTicks(view.case.id, 0);
        continue;
      }
      deps.director.setStallTicks(view.case.id, verdict.ticks);
      if (verdict.type !== "stalled") continue;
      candidates.push({
        caseId: view.case.id,
        reason: "stalled",
        stepId: null,
        detail: `case「${view.case.title}」に実行可能な step が無い状態が ${verdict.ticks} tick 続いています。`,
      });
    }
  }

  async function dispatch(
    team: InquiryRuntimeTeam,
    cases: PatrolCaseView[],
    candidates: readonly InquiryCandidate[],
    fallback: (candidate: InquiryCandidate) => void,
  ): Promise<void> {
    if (candidates.length === 0) return;
    // 日付境界を巡回途中で跨いでも、計画・日次集計・冪等キーは同じ UTC 時刻を使う。
    const tickNow = now();
    const triggeredBy = (candidate: InquiryCandidate) => inquiryTriggeredBy({
      stepId: candidate.stepId,
      caseId: candidate.caseId,
      reason: candidate.reason,
      now: tickNow,
    });
    // 既存 run はガード判定と「死んでいるか」判定の両方で要るので、引いた行を残す。
    const existingRuns = new Map<string, InquiryRunRowLike | null>();
    const existingRun = (candidate: InquiryCandidate): InquiryRunRowLike | null => {
      const key = triggeredBy(candidate);
      if (!existingRuns.has(key)) existingRuns.set(key, deps.runs.findRunByTriggeredBy(key));
      return existingRuns.get(key) ?? null;
    };
    const planned = planInquiries({
      candidates,
      hasExistingInquiry: (candidate) => existingRun(candidate) != null,
      hasUnansweredDecision: (caseId) => deps.director.hasUnansweredAskHumanDecisionsForCase(caseId),
      countInquiriesToday: (caseId) => {
        const view = cases.find((candidate) => candidate.case.id === caseId);
        return deps.runs.countRunsByTriggeredByLike(inquiryDailyCountPatterns({
          caseId,
          stepIds: view?.steps.map((step) => step.id) ?? [],
          now: tickNow,
        }));
      },
      limits: deps.limits,
    });

    for (const result of planned) {
      if (result.skipReason === "already-launched") {
        const run = existingRun(result.candidate);
        // 生きている / 完走した問診 run は、それ自身が通知経路なのでカードを重ねない。
        // 死んだ run は decision を出せていないので、カードへ倒して通知を回復する。
        // escalate 側にも日次の重複抑止があるため、毎 tick 出続けることはない。
        if (!run || !DEAD_INQUIRY_RUN_STATUSES.has(run.status)) {
          log.info(
            { team: team.slug, caseId: result.candidate.caseId, reason: result.candidate.reason },
            "inquiry session already started for this case and reason today",
          );
          continue;
        }
        log.info(
          {
            team: team.slug,
            caseId: result.candidate.caseId,
            reason: result.candidate.reason,
            run: run.id,
            status: run.status,
          },
          "inquiry session ended without a decision; falling back to the machine-written card",
        );
        fallback(result.candidate);
        continue;
      }
      if (!result.launch) {
        log.info(
          { team: team.slug, caseId: result.candidate.caseId, reason: result.candidate.reason, skip: result.skipReason },
          "kept the machine-written card instead of an inquiry session",
        );
        fallback(result.candidate);
        continue;
      }
      const launched = await launch(team, cases, result.candidate, triggeredBy(result.candidate));
      if (!launched) fallback(result.candidate);
    }
  }

  async function launch(
    team: InquiryRuntimeTeam,
    cases: PatrolCaseView[],
    candidate: InquiryCandidate,
    triggeredBy: string,
  ): Promise<boolean> {
    const view = cases.find((entry) => entry.case.id === candidate.caseId);
    if (!view) return false;
    const step = candidate.stepId
      ? view.steps.find((entry) => entry.id === candidate.stepId) ?? null
      : null;

    // 計画後に別 caller が起動した場合も二重 spawn を避ける。ただし既に死んでいる run は
    // 通知経路になっていないので、カードへ倒す (dispatch の already-launched と同じ判断)。
    const existing = deps.runs.findRunByTriggeredBy(triggeredBy);
    if (existing) return !DEAD_INQUIRY_RUN_STATUSES.has(existing.status);

    const origins = deps.teamRepos(team.id);
    // project を解決できないときに team の別 repo を推測すると、問診へ無関係なソースを
    // 読ませる情報境界違反になる。未解決でも問診自体は user-home から起動できる。
    const targetRepo = deps.resolveRepo(origins, view.case);
    const latestRun = step?.delegation_run_id
      ? toRunView(deps.runs.findRun(step.delegation_run_id))
      : null;
    const task = renderInquiryInstruction({
      directorCase: view.case,
      step,
      reason: candidate.reason,
      detail: candidate.detail,
      latestRun,
      concordiaUrl: deps.concordiaUrl,
      mentionUserId: deps.mentionUserId?.() ?? null,
    });

    const result = await deps.delegationService.invoke({
      call_name: deps.askCallName,
      args: { task, ...(targetRepo ? { target_repo: targetRepo } : {}) },
      triggered_by: triggeredBy,
      options: { team: team.id, goal_and_go: false },
    });
    if (!result.ok) {
      // service error はローカルパス・コマンド等を含み得るためログへ複製しない。
      log.warn(
        { team: team.slug, caseId: candidate.caseId, reason: candidate.reason, callName: deps.askCallName },
        "inquiry session launch failed; falling back to the machine-written card",
      );
      return false;
    }
    log.info(
      { team: team.slug, caseId: candidate.caseId, reason: candidate.reason, run: result.run.id },
      "inquiry session launched",
    );
    return true;
  }

  return { collectStalls, dispatch };
}

function toRunView(row: InquiryRunRowLike | null): PatrolRunView | null {
  return row ? { id: row.id, status: row.status } : null;
}
