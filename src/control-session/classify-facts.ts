/**
 * 分類 (session-classify.ts) の入力を既存の所有者から読み集める。
 * 人間待ちは安い照会 (DB) を全員に、transcript・git・Revisor を読む照会は無活動が
 * STALL_IDLE_SEC を超えたものだけに行う。照会できない待ちは「待っている」側に倒す
 * (人間の判断停止や審査中の作業へ追加指示を送らない)。
 *
 * @implements spec/feature/control-session.md §2
 */
import { STALL_IDLE_SEC, type SessionClassifyInput } from "../control/session-classify.js";
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import type { SessionRow } from "../shared/types.js";
import { INELIGIBLE_REASON_LABEL, type EligibilityProbes } from "./instruction-eligibility.js";
import { needsReflectCheck, PATROL_ANSWER_MIN_DELAY_SEC, patrolNudgeToken, type PatrolNudgeState } from "./patrol-nudge-policy.js";
import type { ReaperGitRunner } from "./reaper-facts.js";
import { classifyChild } from "./reaper-policy.js";
import { openPrForSession, reviewLookupGiveUpNote, reviewLookupGivenUp } from "./review-status-source.js";
import type { ConfirmationActivity } from "../control/human-response-activity-release.js";
import { observeConfirmationActivity } from "./confirmation-activity.js";

export interface ClassifyFactPorts {
  probes: Omit<EligibilityProbes, "isControlSession">;
  /** 審査中 (open) の Revisor PR。1 巡回で 1 回だけ読む想定 (呼び出し側でまとめる)。 */
  listOpenLocalPrs(): Promise<RevisorLocalPr[]>;
  /** このセッションが親として待っている実行中の委託 run id。 */
  runningDelegations(sessionId: string): string[];
  findLocalPrByBranch(repository: string, branch: string): Promise<RevisorLocalPr | null>;
  findRun(runId: string): { child_session_id: string | null; parent_session_id: string | null } | null;
  parentReceivedRunTerminal(parentSessionId: string, runId: string): boolean;
  /** transcript 末尾に目印が入っているか。読めなければ null。 */
  transcriptContains(session: SessionRow, token: string): Promise<boolean | null>;
  git: ReaperGitRunner;
  /**
   * 人間の応答待ちの確認を、観測された動き (確認後のコミット・PR の提出/更新) で解く。
   * 解いたら理由、据え置きなら null (human-response-activity-release.ts)。
   */
  releaseConfirmationOnActivity?(sessionId: string, observed: ConfirmationActivity, nowSec: number): string | null;
}

const BASE_BRANCHES = new Set(["main", "master", "develop"]);

function metadataOf(session: SessionRow): Record<string, unknown> {
  try {
    const value = JSON.parse(session.metadata ?? "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 人間の判断待ちの理由。includeAsk=false なら transcript を読まない。 */
export async function humanWaitReason(
  session: SessionRow, probes: ClassifyFactPorts["probes"], includeAsk: boolean,
): Promise<string | null> {
  try {
    if (probes.isAutoCheckDisabled(session)) return INELIGIBLE_REASON_LABEL.auto_check_off;
    if (probes.hasPendingQuestion(session.id)) return INELIGIBLE_REASON_LABEL.pending_question;
    if (probes.isHumanWaitActive(session.id)) return INELIGIBLE_REASON_LABEL.human_wait;
    if (probes.isWaitingForHumanResponse(session.id)) return INELIGIBLE_REASON_LABEL.awaiting_human_response;
    if (!includeAsk) return null;
    const ask = await probes.isAwaitingAsk(session);
    if (ask === null) return INELIGIBLE_REASON_LABEL.state_unavailable;
    return ask ? INELIGIBLE_REASON_LABEL.ask_marker : null;
  } catch {
    return INELIGIBLE_REASON_LABEL.state_unavailable;
  }
}

/**
 * 審査中 PR・実行中の委託。PR 一覧を読めなければ待っている側に倒すが、読み取り失敗が
 * REVIEW_LOOKUP_GIVE_UP_TICKS 巡回続いたら (lookupFailedTicks) 待つ理由にしない。
 */
export function awaitingResultReason(
  session: SessionRow, openPrs: readonly RevisorLocalPr[] | null, runningRuns: readonly string[], lookupFailedTicks = 0,
): string | null {
  if (openPrs === null && !reviewLookupGivenUp(lookupFailedTicks)) {
    return lookupFailedTicks > 0 ? `審査状況を確認できない (${lookupFailedTicks} 巡回連続)` : "審査状況を確認できない";
  }
  const pr = openPrs ? openPrForSession(openPrs, session) : null;
  if (pr) return `審査中 PR #${pr.number} (${pr.checkStatus})`;
  if (runningRuns.length) return `委託 run ${runningRuns[0]}${runningRuns.length > 1 ? ` ほか ${runningRuns.length - 1} 件` : ""} の結果待ち`;
  return null;
}

async function uncommitted(ports: ClassifyFactPorts, session: SessionRow): Promise<boolean | null> {
  try {
    const status = await ports.git(session.repo_path, ["status", "--porcelain"]);
    return status.ok ? status.stdout.trim() !== "" : null;
  } catch {
    return null;
  }
}

/** 担当作業が終わった根拠。委託 run の終了を親が受け取った、または担当ブランチの PR がマージ済み。 */
async function workDoneReason(ports: ClassifyFactPorts, session: SessionRow): Promise<string | null> {
  try {
    const link = classifyChild({ sessionId: session.id, metadata: metadataOf(session), findRun: ports.findRun });
    if (link?.kind === "delegation" && link.runId && link.parentSessionId
      && ports.parentReceivedRunTerminal(link.parentSessionId, link.runId)) {
      return "依頼完了 (委託 run の終了を親が受信済み)";
    }
    if (!session.repo_origin || !session.branch || BASE_BRANCHES.has(session.branch)) return null;
    const pr = await ports.findLocalPrByBranch(session.repo_origin, session.branch);
    return pr?.status === "merged" ? `担当 PR #${pr.number} マージ済み` : null;
  } catch {
    return null;
  }
}

/** 届けた追加指示が猶予後も会話に現れず、その後の活動も無い。 */
async function injectUnreflected(
  ports: ClassifyFactPorts, session: SessionRow, state: PatrolNudgeState, lastActivitySec: number | null, nowSec: number,
): Promise<boolean> {
  if (!needsReflectCheck(state, nowSec)) return false;
  if (lastActivitySec !== null && state.lastAt !== null && lastActivitySec > state.lastAt + PATROL_ANSWER_MIN_DELAY_SEC) return false;
  try {
    return (await ports.transcriptContains(session, patrolNudgeToken(state.count))) === false;
  } catch {
    return false;
  }
}

/** 人間の応答待ちの確認が立っているセッションだけ、動きを観測して解けるか確かめる。 */
async function releaseConfirmationIfMoved(input: {
  ports: ClassifyFactPorts; session: SessionRow; openPrs: () => Promise<RevisorLocalPr[] | null>; nowSec: number;
}): Promise<void> {
  const { ports, session } = input;
  if (!ports.releaseConfirmationOnActivity) return;
  try {
    if (!ports.probes.isWaitingForHumanResponse(session.id)) return;
    const observed = await observeConfirmationActivity(ports.git, session, await input.openPrs());
    ports.releaseConfirmationOnActivity(session.id, observed, input.nowSec);
  } catch {
    // 解けなければ従来どおり待ちのまま (humanWaitReason が読む)。
  }
}

export async function gatherClassifyInput(input: {
  ports: ClassifyFactPorts;
  session: SessionRow;
  lastActivitySec: number | null;
  nudge: PatrolNudgeState;
  openPrs: () => Promise<RevisorLocalPr[] | null>;
  /** 今回を含む審査状況の読み取り失敗の連続巡回数 (openPrs を読んだ後に呼ぶ)。 */
  reviewLookupStreak?: () => number;
  nowSec: number;
}): Promise<SessionClassifyInput> {
  const { ports, session, nowSec } = input;
  const idleSec = input.lastActivitySec === null ? null : Math.max(0, nowSec - input.lastActivitySec);
  const idle = idleSec !== null && idleSec >= STALL_IDLE_SEC;
  await releaseConfirmationIfMoved(input);
  const base: SessionClassifyInput = {
    idleSec,
    humanWait: await humanWaitReason(session, ports.probes, idle),
    awaitingResult: null,
    uncommitted: null,
    workDone: null,
    unansweredNudges: input.nudge.count,
    injectUnreflected: false,
  };
  if (!idle || base.humanWait) return base;
  let running: string[] = [];
  try {
    running = ports.runningDelegations(session.id);
  } catch {
    running = [];
  }
  const openPrs = await input.openPrs();
  const failedTicks = openPrs === null ? (input.reviewLookupStreak?.() ?? 0) : 0;
  const awaiting = awaitingResultReason(session, openPrs, running, failedTicks);
  if (awaiting) return { ...base, awaitingResult: awaiting };
  return {
    ...base,
    reviewNote: openPrs === null ? reviewLookupGiveUpNote(failedTicks) : null,
    uncommitted: await uncommitted(ports, session),
    workDone: await workDoneReason(ports, session),
    injectUnreflected: await injectUnreflected(ports, session, input.nudge, input.lastActivitySec, nowSec),
  };
}
