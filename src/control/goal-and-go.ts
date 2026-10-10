import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { shouldClearIdleNudgeFromFrame } from "./idle-nudge.js";
import { describeGoal, readGoalFromMetadata, type Goal } from "./goal.js";
import { parseRequesterSource } from "./requester.js";
import { allowAutoInject, type PendingQuestionProbe } from "./pending-question-blocker.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { isHumanWaitActive } from "./human-wait.js";

export const GOAL_AND_GO_SOURCE = "auto:goal-and-go";

export interface GoalAndGoStatus {
  enabled: boolean;
  continuation_count: number;
  started_at: number | null;
  last_continued_at: number | null;
  stopped_reason: "continuation_limit" | "runtime_limit" | null;
  /**
   * 人間の指示 (ユーザ発話・人間由来 inject・user_activity) を一度でも受けたか。
   * 受けていないセッションには自走継続を送らない (2026-10-07 neco 指示: 指示されていない
   * セッション外のタスクを持ち込まない)。明示ゴールの登録も指示として扱う。
   */
  instructed?: boolean;
}

const DEFAULT_STATUS: GoalAndGoStatus = {
  enabled: true,
  continuation_count: 0,
  started_at: null,
  last_continued_at: null,
  stopped_reason: null,
};

export interface StartGoalAndGoOptions {
  repo: SessionsRepo;
  taskStore?: {
    findByRelativePath(repoPath: string, relativePath: string): Promise<{ status: string } | null>;
    readonly authoritative?: boolean;
    canContinue?(repoPath: string, reference: string, subsidiaryId: string | null, sessionId?: string): Promise<boolean>;
  };
  /**
   * 未回答の質問があるセッションは自走継続しない (blocker)。未注入なら従来どおり継続。
   * @see ./pending-question-blocker.js
   */
  hasPendingQuestion?: PendingQuestionProbe;
  /** 自動確認を送らないセッション (部署の auto_check が off、 departments.md §9.6)。 */
  isAutoCheckDisabled?: (session: SessionRow) => boolean;
  seconds: number;
  maxContinuations: number;
  maxRuntimeSec: number;
  keepTimersRefed?: boolean;
  now?: () => number;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface GoalAndGoHandle {
  stop(): void;
}

export function readGoalAndGoStatus(metadata: string | null | undefined): GoalAndGoStatus {
  if (!metadata) return { ...DEFAULT_STATUS };
  try {
    const parsed = JSON.parse(metadata) as { goal_and_go?: unknown };
    if (parsed.goal_and_go === true) return { ...DEFAULT_STATUS, enabled: true };
    if (parsed.goal_and_go === false) return { ...DEFAULT_STATUS, enabled: false };
    if (!isRecord(parsed.goal_and_go)) return { ...DEFAULT_STATUS };
    const value = parsed.goal_and_go;
    return {
      enabled: value.enabled !== false,
      continuation_count: nonNegativeInteger(value.continuation_count),
      started_at: nullableTimestamp(value.started_at),
      last_continued_at: nullableTimestamp(value.last_continued_at),
      stopped_reason:
        value.stopped_reason === "continuation_limit" || value.stopped_reason === "runtime_limit"
          ? value.stopped_reason
          : null,
      ...(value.instructed === true ? { instructed: true } : {}),
    };
  } catch {
    return { ...DEFAULT_STATUS };
  }
}

export function mergeGoalAndGoStatus(
  metadata: string | null | undefined,
  status: GoalAndGoStatus,
): string {
  let base: Record<string, unknown> = {};
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (isRecord(parsed)) base = parsed;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, goal_and_go: status });
}

export function setGoalAndGoEnabled(
  metadata: string | null | undefined,
  enabled: boolean,
): string {
  return mergeGoalAndGoStatus(metadata, { ...DEFAULT_STATUS, enabled });
}

/**
 * 自走の回数・時間予算を戻す。 `instructed: true` は保つ。 無効化されたセッションは触らない。
 *
 * 呼んでよいのはデイリーゴール自走の 1 時間ごとの確認 (進捗あり、 または完了確認で AI だけで
 * 進められる残りがある場合) だけ。 CC-WM-INV-03 で許す唯一の緩和で、 回答待ちと止まる条件に
 * 当たった後は呼び出し側が呼ばない (spec/feature/daily-goal-run.md — 予算)。
 * 人間入力によるリセット (startGoalAndGo の clear) の挙動は変えない。
 */
export function resetGoalAndGoBudget(
  repo: Pick<SessionsRepo, "findSession" | "setMetadata">,
  sessionId: string,
): boolean {
  const session = repo.findSession(sessionId);
  if (!session) return false;
  const status = readGoalAndGoStatus(session.metadata);
  if (!status.enabled) return false;
  repo.setMetadata(sessionId, mergeGoalAndGoStatus(session.metadata, { ...DEFAULT_STATUS, enabled: true, instructed: true }));
  return true;
}

export function buildGoalAndGoPrompt(input: {
  metadata: string | null | undefined;
  currentTask?: string | null;
  attempt: number;
  maxContinuations: number;
}): string {
  const explicitGoal = readExplicitGoal(input.metadata);
  const focus = explicitGoal
    ? [
        `明示ゴール: ${describeGoal(explicitGoal)}`,
        "現在の達成度を評価し、未達なら次の具体的なタスクを定義して、そのまま実行してください。",
      ]
    : [
        "明示ゴールは登録されていません。",
        "人間から受けた指示の作業に残りがあるときだけ、その作業を続けてください。受けた指示の作業が終わっていれば何もせず待機してください。",
      ];
  const currentTask = input.currentTask?.trim()
    ? [`Cc上の現在タスク: ${input.currentTask.trim()}`]
    : [];
  return [
    `[Concordia goal-and-go ${input.attempt}/${input.maxContinuations}]`,
    "人間から新しい入力がないため、自走継続の判断を行ってください。",
    ...focus,
    ...currentTask,
    "指示されていないセッション外のタスク (Actio の未着手 task、git diff、TODO など) を持ち込まないでください。作業してよいのは、このセッションが人間から受けた指示の範囲だけです。",
    "受けた指示の作業の1ループは実装・審査・マージ・反映の確認までです。各操作は既存の人間の許可範囲で判断し、Test OKだけで完了にしないでください。",
    "受けた指示の作業が審査待ちや判断待ちで止まったら、同じ指示の範囲で進められる作業だけを進めてください。審査待ちの重複提出はしないでください。",
    "ループの区切りでは予定タスクを列挙し、実行中は GO、待機するものには理由を示してください。進められるものが無ければ必要な人間判断を要約し、POST /v1/sessions/:id/human-wait に summary と task_references を記録して待機してください。人間の回答まで自動確認を止めます。",
  ].join("\n");
}

/**
 * `taskflow.continue_requested` が保存する current_task から task md の相対パスを読む。
 * @implements spec/tasks/2026-09-01-goal-and-go-stale-current-task-guard.md
 */
export function extractTaskMdPath(currentTask: string | null | undefined): string | null {
  if (!currentTask) return null;
  const match = /\((actio:[A-Za-z0-9-]+|spec\/tasks\/[^/()]+\.md)\)$/.exec(currentTask.trim());
  return match?.[1] ?? null;
}

export function startGoalAndGo(opts: StartGoalAndGoOptions): GoalAndGoHandle {
  const seconds = Math.floor(opts.seconds);
  const maxContinuations = Math.max(1, Math.floor(opts.maxContinuations));
  const maxRuntimeSec = Math.max(1, Math.floor(opts.maxRuntimeSec));
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const globallyEnabled = seconds > 0;
  const continuationGenerations = new Map<string, number>();
  let stopped = false;

  const nextContinuationGeneration = (sessionId: string): number => {
    const generation = (continuationGenerations.get(sessionId) ?? 0) + 1;
    continuationGenerations.set(sessionId, generation);
    return generation;
  };

  const saveStatus = (sessionId: string, status: GoalAndGoStatus): void => {
    const session = opts.repo.findSession(sessionId);
    if (!session) return;
    opts.repo.setMetadata(sessionId, mergeGoalAndGoStatus(session.metadata, status));
  };

  /** 人間の入力で呼ぶ。指示を受けた印を付け、自走の回数・時間予算をリセットする。 */
  const resetProgress = (sessionId: string): void => {
    const session = opts.repo.findSession(sessionId);
    if (!session) return;
    const status = readGoalAndGoStatus(session.metadata);
    if (!status.enabled) return;
    if (
      status.instructed === true &&
      status.continuation_count === 0 &&
      status.started_at === null &&
      status.last_continued_at === null &&
      status.stopped_reason === null
    ) return;
    saveStatus(sessionId, { ...DEFAULT_STATUS, enabled: true, instructed: true });
  };

  const markStopped = (
    sessionId: string,
    status: GoalAndGoStatus,
    reason: NonNullable<GoalAndGoStatus["stopped_reason"]>,
  ): void => {
    saveStatus(sessionId, { ...status, stopped_reason: reason });
    opts.repo.appendEvent({
      session_id: sessionId,
      ts: now(),
      kind: "goal_and_go_stopped",
      payload: { reason, continuation_count: status.continuation_count },
    });
    opts.log?.warn(`goal-and-go stopped session=${sessionId} reason=${reason}`);
  };

  const continueSession = (sessionId: string): void => {
    const session = opts.repo.findSession(sessionId);
    if (!session) return;
    const generation = nextContinuationGeneration(sessionId);
    if (session.status !== "active") return;
    const status = readGoalAndGoStatus(session.metadata);
    if (!status.enabled || status.stopped_reason !== null) return;
    // 人間の指示を一度も受けていないセッションは自走させない (明示ゴールは指示として扱う)。
    if (status.instructed !== true && !readExplicitGoal(session.metadata)) return;
    if (opts.isAutoCheckDisabled?.(session)) return;
    // 人間の回答待ちなら自走しない。continuation_count も消費せず、回答後の継続を残す。
    if (isHumanWaitActive(opts.repo, sessionId) || !allowAutoInject({
      probe: opts.hasPendingQuestion,
      sessionId,
      source: GOAL_AND_GO_SOURCE,
      log: opts.log,
    })) return;
    const at = now();
    if (status.continuation_count >= maxContinuations) {
      markStopped(sessionId, status, "continuation_limit");
      return;
    }
    if (status.started_at !== null && at - status.started_at >= maxRuntimeSec) {
      markStopped(sessionId, status, "runtime_limit");
      return;
    }

    const inject = (currentTask: string | null): void => {
      const latest = opts.repo.findSession(sessionId);
      if (!latest || latest.status !== "active" || latest.repo_path !== session.repo_path
        || latest.repo_origin !== session.repo_origin || latest.branch !== session.branch
        || latest.target_project !== session.target_project
        || readSubsidiaryId(latest.metadata) !== readSubsidiaryId(session.metadata)
        || isHumanWaitActive(opts.repo, sessionId)
        || !allowAutoInject({ probe: opts.hasPendingQuestion, sessionId, source: GOAL_AND_GO_SOURCE, log: opts.log })) return;
      const next: GoalAndGoStatus = {
        ...status,
        continuation_count: status.continuation_count + 1,
        started_at: status.started_at ?? at,
        last_continued_at: at,
      };
      saveStatus(sessionId, next);
      const text = buildGoalAndGoPrompt({
        metadata: session.metadata,
        currentTask,
        attempt: next.continuation_count,
        maxContinuations,
      });
      opts.repo.appendEvent({
        session_id: sessionId,
        ts: at,
        kind: "inject",
        payload: { text, source: GOAL_AND_GO_SOURCE, attempt: next.continuation_count },
      });
      eventBus.emit({
        type: "session.inject",
        target_session_id: sessionId,
        text,
        source: GOAL_AND_GO_SOURCE,
        ts: at,
      });
      opts.log?.info(`goal-and-go continued session=${sessionId} attempt=${next.continuation_count}/${maxContinuations}`);
    };

    const taskPath = extractTaskMdPath(session.current_task);
    if (!opts.taskStore || !taskPath) {
      inject(session.current_task);
      return;
    }
    void resolveCurrentTaskForPrompt({
      repoPath: session.repo_path,
      currentTask: session.current_task,
      taskPath,
      taskStore: opts.taskStore,
    }).then(async (resolution) => {
      if (opts.taskStore?.canContinue && !await opts.taskStore.canContinue(session.repo_path, taskPath, readSubsidiaryId(session.metadata), sessionId)) return;
      const current = opts.repo.findSession(sessionId);
      if (
        stopped
        || continuationGenerations.get(sessionId) !== generation
        || !current
        || current.status !== "active"
        || current.current_task !== session.current_task
        || current.repo_path !== session.repo_path || current.repo_origin !== session.repo_origin
        || current.branch !== session.branch || current.target_project !== session.target_project
        || readSubsidiaryId(current.metadata) !== readSubsidiaryId(session.metadata)
        || current.metadata !== session.metadata
      ) return;
      if (isHumanWaitActive(opts.repo, sessionId)
        || !allowAutoInject({ probe: opts.hasPendingQuestion, sessionId, source: GOAL_AND_GO_SOURCE, log: opts.log })) return;
      if (resolution.dropReason) {
        opts.repo.patchSession(sessionId, { current_task: null });
        opts.repo.appendEvent({
          session_id: sessionId,
          ts: at,
          kind: "goal_and_go_current_task_dropped",
          payload: { path: taskPath, reason: resolution.dropReason },
        });
      }
      inject(resolution.currentTask);
    }).catch(() => {
      // Event callbacks cannot await this best-effort validation; never leave a rejected promise unhandled.
      opts.log?.warn(`goal-and-go continuation aborted session=${sessionId}`);
    });
  };

  const unsubscribe = eventBus.subscribe((event) => {
    if (!globallyEnabled) return;
    if (event.type === "taskflow.continue_requested") {
      const session = opts.repo.findSession(event.target_session_id);
      if (!session || isHumanWaitActive(opts.repo, event.target_session_id)
        || !allowAutoInject({ probe: opts.hasPendingQuestion, sessionId: event.target_session_id,
          source: GOAL_AND_GO_SOURCE, log: opts.log })) return;
      // 残作業 sweep が見つけた次タスク (event.text) はセッションの外から来た、指示されていない
      // タスクなので current_task に持ち込まない (2026-10-07 neco 指示)。セッション自身の作業だけを続ける。
      continueSession(event.target_session_id);
      return;
    }
    // arm 相当 (idle 経過での自走継続) は お伺い側へ移譲済み (feature/inquiry.md §8)。
    // ここに残るのは「人間の入力で進捗をリセットする」clear 側だけ。
    handleGoalAndGoEvent(event, {
      clear: (sessionId, reset) => {
        if (!reset) {
          continuationGenerations.delete(sessionId);
          return;
        }
        nextContinuationGeneration(sessionId);
        resetProgress(sessionId);
      },
    });
  });
  opts.log?.info(globallyEnabled
    ? `goal-and-go started (${seconds}s, max=${maxContinuations}, runtime=${maxRuntimeSec}s)`
    : "goal-and-go disabled globally");

  return {
    stop() {
      stopped = true;
      continuationGenerations.clear();
      unsubscribe();
    },
  };
}

async function resolveCurrentTaskForPrompt(input: {
  repoPath: string;
  currentTask: string | null;
  taskPath: string;
  taskStore: NonNullable<StartGoalAndGoOptions["taskStore"]>;
}): Promise<{
  currentTask: string | null;
  dropReason: "missing" | "not_pending" | null;
}> {
  try {
    const task = await input.taskStore.findByRelativePath(input.repoPath, input.taskPath);
    const eligible = task?.status === "pending" || (!!input.taskStore.canContinue && task?.status === "delegated");
    const reason = !task ? "missing" : !eligible ? "not_pending" : null;
    return { currentTask: reason ? null : input.currentTask, dropReason: reason };
  } catch {
    // An authoritative store cannot be second-guessed: continuing on a stale task
    // would drive work against a task whose real state is unknown.
    if (input.taskStore.authoritative) throw new Error("Authoritative task store unavailable; continuation stopped");
    // A transient task-store failure must not erase the session's last known task.
    return { currentTask: input.currentTask, dropReason: null };
  }
}

function handleGoalAndGoEvent(
  event: ConcordiaEvent,
  actions: { clear: (sessionId: string, reset: boolean) => void },
): void {
  if (event.type === "transcript.frame") {
    if (shouldClearIdleNudgeFromFrame(event)) {
      actions.clear(event.target_session_id, true);
      return;
    }
    return;
  }
  if (event.type === "session.inject" && parseRequesterSource(event.source)) {
    actions.clear(event.target_session_id, true);
    return;
  }
  if (event.type === "session.event" && event.kind === "user_activity") {
    actions.clear(event.session_id, true);
    return;
  }
  if (event.type === "session.ended" || event.type === "session.lost") {
    actions.clear(event.session_id, false);
  }
}

function readExplicitGoal(metadata: string | null | undefined): Goal | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.goal)) return null;
    return readGoalFromMetadata(metadata);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function nullableTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}
