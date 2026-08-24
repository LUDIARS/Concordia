/**
 * @implements spec/feature/director-patrol.md §1
 *
 * Director 巡回の実行系。
 *
 * 30 分ごとに全チームを巡回し、patrol.ts の計画を repo 更新・delegation invoke・
 * question カード発行として適用する。1 チームの失敗は他チームへ波及させない。
 * 二重起動防止は `triggered_by = "director-patrol:<step_id>"` の固定キーで行う
 * (invoke 成功 → step への記録前に落ちても、次 tick で既存 run を復元する)。
 */

import { concordiaBaseUrl } from "../config/service-urls.js";
import { resolveClonePaths, repoNameFromOrigin, isSafeRepoName } from "../release/clone-paths.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import { eventBus } from "../events.js";
import {
  planTeamPatrol,
  type PatrolAction,
  type PatrolCaseView,
  type PatrolLimits,
  type PatrolRunView,
} from "./patrol.js";
import {
  inquiryTriggeredBy,
  type InquiryCandidate,
  type InquiryLimits,
  type InquiryReason,
} from "./inquiry-patrol.js";
import { createInquiryRuntime } from "./inquiry-runtime.js";
import type { DirectorCase, DirectorStep } from "./types.js";

const log = createChildLogger("director-patrol");
const TICK_MS = 30 * 60 * 1000;
const DEFAULT_IMPL_CALL_NAME = "sonnet-mid";
const DEFAULT_ASK_CALL_NAME = "claude-sonnet-5-ask";

/** 巡回起動の triggered_by 固定キー (冪等性の正本)。 */
export function patrolTriggeredBy(stepId: string): string {
  return `director-patrol:${stepId}`;
}

/** 問診起動の triggered_by (日付を含む。spec/feature/director-inquiry-session.md §2)。 */
export { inquiryTriggeredBy };

interface PatrolTeam {
  id: string;
  name: string;
  slug: string;
}

interface PatrolDirectorRepo {
  listCases(filter: { teamId?: string; limit?: number }): DirectorCase[];
  findCaseDetail(id: string): { case: DirectorCase; steps: DirectorStep[] } | null;
  updateStepStatus(input: {
    id: string;
    status: DirectorStep["status"];
    handoff_note: string | null | undefined;
    updated_at: number;
    expected_status?: DirectorStep["status"];
  }): DirectorStep | null;
  assignStepRun(input: {
    id: string;
    delegation_run_id: string;
    updated_at: number;
    expected_status: "pending";
  }): DirectorStep | null;
  /** 問診ガード: 当該 case に未回答の問診 decision が残っているか (spec §4)。 */
  hasUnansweredAskHumanDecisionsForCase(caseId: string): boolean;
  getStallTicks(caseId: string): number;
  setStallTicks(caseId: string, ticks: number): void;
}

/** DelegationRunRow のうち巡回が読む最小形 (行の他カラムは任意)。 */
interface PatrolRunRowLike {
  id: string;
  status: PatrolRunView["status"];
}

interface PatrolDelegationRuns {
  findRun(id: string): PatrolRunRowLike | null;
  findRunByTriggeredBy(triggeredBy: string): PatrolRunRowLike | null;
  /** 問診の日次上限を永続記録から数える (spec §4)。 */
  countRunsByTriggeredByLike(patterns: readonly string[]): number;
}

interface PatrolDelegationService {
  invoke(input: {
    call_name: string;
    args: Record<string, unknown>;
    triggered_by?: string;
    options?: Record<string, unknown>;
  }): Promise<{ ok: true; run: { id: string } } | { ok: false; error: string }>;
}

export interface DirectorPatrolDeps {
  teams: { list(): PatrolTeam[]; repos(id: string): string[] };
  director: PatrolDirectorRepo;
  runs: PatrolDelegationRuns;
  delegationService: PatrolDelegationService;
  workspaceRoots: string[];
  /** 実装委託テンプレ。既定 sonnet-mid (env CONCORDIA_DIRECTOR_IMPL_CALL_NAME)。 */
  implCallName?: string;
  /** 問診委託テンプレ。既定 claude-sonnet-5-ask (env CONCORDIA_DIRECTOR_ASK_CALL_NAME)。 */
  askCallName?: string;
  /** 問診指示に載せる Concordia endpoint。既定は service-urls の正本。 */
  concordiaUrl?: string;
  /** 問診指示の先頭に付けるメンション先 (spec §2 の呼び出し)。 */
  mentionUserId?: () => string | null;
  inquiryLimits?: Partial<InquiryLimits>;
  /** テスト用: 対象リポ解決の差し替え。既定は resolveTargetRepo (clone-paths)。 */
  resolveRepo?: (origins: readonly string[], directorCase: DirectorCase) => string | null;
  limits?: Partial<PatrolLimits>;
  tickMs?: number;
  now?: () => number;
  emit?: (event: Parameters<typeof eventBus.emit>[0]) => void;
}

export interface DirectorPatrolHandle {
  stop: () => void;
  /** テスト・手動起動用。全チームを 1 巡する。 */
  runOnce: () => Promise<void>;
}

export function startDirectorPatrol(deps: DirectorPatrolDeps): DirectorPatrolHandle {
  let stopped = false;
  let running = false;
  const implCallName = (
    deps.implCallName ?? process.env.CONCORDIA_DIRECTOR_IMPL_CALL_NAME ?? DEFAULT_IMPL_CALL_NAME
  ).trim() || DEFAULT_IMPL_CALL_NAME;
  const askCallName = (
    deps.askCallName ?? process.env.CONCORDIA_DIRECTOR_ASK_CALL_NAME ?? DEFAULT_ASK_CALL_NAME
  ).trim() || DEFAULT_ASK_CALL_NAME;
  const concordiaUrl = (deps.concordiaUrl ?? concordiaBaseUrl()).trim();
  const emit = deps.emit ?? ((event) => eventBus.emit(event));
  const now = deps.now ?? (() => Date.now());
  /** 同一 case × 理由のカード重複抑止 (プロセス内・日単位)。spec §1.4。 */
  const escalated = new Map<string, string>();
  const resolveRepo = deps.resolveRepo
    ?? ((origins: readonly string[], directorCase: DirectorCase) =>
      resolveTargetRepo(origins, directorCase, deps.workspaceRoots));
  const inquiryRuntime = createInquiryRuntime({
    director: deps.director,
    runs: deps.runs,
    delegationService: deps.delegationService,
    teamRepos: (teamId) => deps.teams.repos(teamId),
    resolveRepo,
    askCallName,
    concordiaUrl,
    mentionUserId: deps.mentionUserId,
    limits: deps.inquiryLimits,
    now,
  });

  async function patrolTeam(team: PatrolTeam): Promise<void> {
    const cases: PatrolCaseView[] = deps.director
      .listCases({ teamId: team.id })
      .map((row) => deps.director.findCaseDetail(row.id))
      .filter((detail): detail is { case: DirectorCase; steps: DirectorStep[] } => detail != null);
    if (cases.length === 0) return;

    const actions = planTeamPatrol({
      cases,
      findRun: (runId) => toRunView(deps.runs.findRun(runId)),
      limits: deps.limits,
    });

    // エスカレーション事由はここで機械文カードにせず、いったん問診の起動候補として溜める
    // (spec/feature/director-inquiry-session.md §1)。問診を出すか機械文へ倒すかは
    // ガードを通してから決まるので、判断を 1 箇所に集める。
    const candidates: InquiryCandidate[] = [];
    const staleCases = new Set<string>();
    for (const action of actions) {
      if (staleCases.has(action.caseId)) continue;
      try {
        const applied = await applyAction(team, cases, action, candidates);
        if (!applied) staleCases.add(action.caseId);
      } catch (error) {
        staleCases.add(action.caseId);
        log.warn(
          { team: team.slug, action: action.type, caseId: action.caseId, err: (error as Error).message },
          "patrol action failed",
        );
      }
    }

    inquiryRuntime.collectStalls(cases, staleCases, candidates);
    await inquiryRuntime.dispatch(
      team,
      cases,
      candidates,
      (candidate) => escalate(team, cases, candidate),
    );
  }

  async function applyAction(
    team: PatrolTeam,
    cases: PatrolCaseView[],
    action: PatrolAction,
    candidates: InquiryCandidate[],
  ): Promise<boolean> {
    if (action.type === "advance") {
      const updated = deps.director.updateStepStatus({
        id: action.stepId,
        status: "completed",
        handoff_note: undefined,
        updated_at: now(),
        expected_status: "active",
      });
      if (!updated) return false;
      log.info({ team: team.slug, step: action.stepId }, "patrol advanced step to completed");
      return true;
    }
    if (action.type === "block") {
      const updated = deps.director.updateStepStatus({
        id: action.stepId,
        status: "blocked",
        handoff_note: action.note,
        updated_at: now(),
        expected_status: "active",
      });
      if (!updated) return false;
      log.info({ team: team.slug, step: action.stepId }, "patrol blocked step");
      return true;
    }
    if (action.type === "escalate") {
      candidates.push({
        caseId: action.caseId,
        reason: action.reason,
        stepId: action.stepId ?? null,
        detail: action.detail,
      });
      return true;
    }
    return launch(team, cases, action, candidates);
  }

  async function launch(
    team: PatrolTeam,
    cases: PatrolCaseView[],
    action: Extract<PatrolAction, { type: "launch" }>,
    candidates: InquiryCandidate[],
  ): Promise<boolean> {
    const view = cases.find((candidate) => candidate.case.id === action.caseId);
    const step = view?.steps.find((candidate) => candidate.id === action.stepId);
    if (!view || !step) return false;

    // 冪等復元: 既に同じ step の run があれば invoke せず参照だけ直す。
    const triggeredBy = patrolTriggeredBy(step.id);
    const existing = deps.runs.findRunByTriggeredBy(triggeredBy);
    if (existing) {
      const assigned = deps.director.assignStepRun({
        id: step.id,
        delegation_run_id: existing.id,
        updated_at: now(),
        expected_status: "pending",
      });
      if (!assigned) return false;
      log.info({ team: team.slug, step: step.id, run: existing.id }, "patrol recovered existing run");
      return true;
    }

    const targetRepo = resolveRepo(deps.teams.repos(team.id), view.case);
    if (!targetRepo) {
      // 起動時にしか分からない事由なので、ここで問診の起動候補へ積む。
      // 実際に問診を出すか機械文へ倒すかは inquiry runtime のガードが決める。
      candidates.push({
        caseId: view.case.id,
        reason: "repo-unresolved",
        stepId: step.id,
        detail: `case「${view.case.title}」の対象リポジトリを team repos から解決できません (project=${view.case.project})。`,
      });
      return true;
    }

    const result = await deps.delegationService.invoke({
      call_name: implCallName,
      args: {
        task: renderTask(view.case, step),
        target_repo: targetRepo,
      },
      triggered_by: triggeredBy,
      options: { team: team.id, goal_and_go: true },
    });
    if (!result.ok) {
      // service error はローカルパス・コマンド等を含み得るためログ/カードへ複製しない。
      log.warn({ team: team.slug, step: step.id, callName: implCallName }, "patrol launch failed");
      candidates.push({
        caseId: view.case.id,
        reason: "launch-failed",
        stepId: step.id,
        detail: `step「${step.title}」の委託起動に失敗しました。詳細は内部ログを確認してください。`,
      });
      return true;
    }
    const assigned = deps.director.assignStepRun({
      id: step.id,
      delegation_run_id: result.run.id,
      updated_at: now(),
      expected_status: "pending",
    });
    if (!assigned) return false;
    log.info(
      { team: team.slug, caseId: view.case.id, step: step.id, run: result.run.id },
      "patrol launched implement session",
    );
    return true;
  }

  /**
   * 従来の機械文 question カード (patrol §1.4)。
   *
   * 問診セッションを起こさなかった / 起こせなかったときのフォールバックであり、
   * 「人間への通知は落とさない」を担保する最後の砦。
   */
  function escalate(
    team: PatrolTeam,
    cases: PatrolCaseView[],
    action: { caseId: string; reason: InquiryReason; detail: string },
  ): void {
    const day = new Date(now()).toISOString().slice(0, 10);
    const key = `${action.caseId}:${action.reason}`;
    if (escalated.get(key) === day) return;
    // 日が変わったら前日までのキーは二度と一致しないので捨てる。放置すると
    // case 数 × 事由数ぶん無限に積む (長時間動くプロセスなので実際に効く)。
    for (const [staleKey, staleDay] of escalated) {
      if (staleDay !== day) escalated.delete(staleKey);
    }
    escalated.set(key, day);
    const title = cases.find((view) => view.case.id === action.caseId)?.case.title ?? action.caseId;
    emit({
      type: "team.card_requested",
      team_id: team.id,
      kind: "question",
      title: `Director 巡回: 判断が必要 — ${title}`,
      body: `${action.detail}\n\n(理由: ${action.reason} / case: ${action.caseId})`,
      ts: Math.floor(now() / 1000),
    });
    log.info({ team: team.slug, caseId: action.caseId, reason: action.reason }, "patrol escalated to human");
  }

  async function runOnce(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      for (const team of deps.teams.list()) {
        try {
          await patrolTeam(team);
        } catch (error) {
          log.warn({ team: team.slug, err: (error as Error).message }, "patrol team failed");
        }
      }
    } finally {
      running = false;
    }
  }

  const supervised = startSupervisedInterval("director-patrol", runOnce, {
    intervalMs: deps.tickMs ?? TICK_MS,
    initialDelayMs: 15_000,
    log: { warn: (message) => log.warn(message) },
  });
  log.info({ tickMs: deps.tickMs ?? TICK_MS, implCallName, askCallName }, "director patrol started");

  return {
    stop: () => {
      stopped = true;
      supervised.stop();
    },
    runOnce,
  };
}

/** run 行を巡回ビューへ絞る。 */
function toRunView(row: PatrolRunRowLike | null): PatrolRunView | null {
  if (!row) return null;
  return { id: row.id, status: row.status };
}

/**
 * チームの repos と case.project から対象リポのローカルクローンを解決する (spec §1.2)。
 * repo 1 本ならそれ、複数なら case.project と repo 名の一致 (大文字小文字無視) で選ぶ。
 */
export function resolveTargetRepo(
  origins: readonly string[],
  directorCase: DirectorCase,
  workspaceRoots: string[],
): string | null {
  const names = origins.map((origin) => repoNameFromOrigin(origin.replace(/\.git$/i, "")).trim());
  if (names.some((name) => !isSafeRepoName(name))) return null;
  let repoName: string | null = null;
  if (names.length === 1) {
    repoName = names[0] ?? null;
  } else {
    const project = directorCase.project.trim().toLowerCase();
    repoName = names.find((name) => name.toLowerCase() === project) ?? null;
  }
  if (!repoName) return null;
  return resolveClonePaths(repoName, workspaceRoots).main;
}

/** 実装委託テンプレ (`task` 引数) へ渡す指示本文。 */
export function renderTask(directorCase: DirectorCase, step: DirectorStep): string {
  const lines = [
    `[Director] ${directorCase.title} — ${step.title}`,
    "",
    `ゴール: ${directorCase.goal}`,
  ];
  if (step.task_path) lines.push(`タスク定義: ${step.task_path} (先に読むこと)`);
  if (step.handoff_note) lines.push(`引き継ぎ: ${step.handoff_note}`);
  lines.push(
    "",
    "これは Director 巡回からのチーム実装セッションです。上記の step を実装してください。",
    "権限・スコープ・破壊的操作の判断が必要になったら、自分で決めずに人間へ質問してください。",
    "",
    "### 開始時 (必須)",
    "- Excubitor catalog で解決した Concordia endpoint へ `GET /v1/admin/state` を投げ、",
    "  `mention_user_id` があれば最初の着手宣言の先頭に `<@mention_user_id>` を付けて投稿する",
    "  (人間の担当者への最初メンション。値が null/未設定なら付けずに宣言だけ行う)。",
  );
  return lines.join("\n");
}
