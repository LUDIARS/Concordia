/**
 * 子セッションを閉じてよいかの判定に使う事実を、既存の所有者から読み集める。
 * 照会に失敗したものは null にし、判定 (reaper-policy) が「閉じない」に倒す。
 *
 * @implements spec/feature/control-session.md — 9. 子セッションの片付け / CC-CTL-INV-08
 */
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import { matchLocalPrByBranch } from "../pr/revisor-branch-lookup.js";
import type { SessionRow } from "../shared/types.js";
import {
  REAP_STALE_QUESTION_ACTIVITY_SEC,
  TERMINAL_RUN_STATUSES,
  type ChildLink,
  type ReapBlockers,
  type ReapInput,
  type ReapKind,
  type ReapRun,
} from "./reaper-policy.js";

const BASE_BRANCHES = new Set(["main", "master", "develop"]);

/** 片付けの対象。親の記録が無い (standalone) ものは parentSessionId が null。 */
export interface ReapTarget {
  kind: ReapKind;
  parentSessionId: string | null;
  runId: string | null;
}

export interface ReaperGitResult { ok: boolean; stdout: string }
export type ReaperGitRunner = (cwd: string, args: string[]) => Promise<ReaperGitResult>;

export interface ReaperFactPorts {
  /** 親の記録に、委託 run の終端 (completed / partial / failed) の通知が届いているか。 */
  parentReceivedRunTerminal(parentSessionId: string, runId: string): boolean;
  lastActivitySec(sessionId: string): number | null;
  unchangedCount(session: SessionRow): number;
  hasPendingQuestion(sessionId: string): boolean;
  isHumanWaitActive(sessionId: string): boolean;
  isWaitingForHumanResponse(sessionId: string): boolean;
  isAwaitingAsk(session: SessionRow): Promise<boolean>;
  hasTestingClaim(sessionId: string, nowSec: number): boolean;
  listOpenLocalPrs(): Promise<RevisorLocalPr[]>;
  /** (リポジトリ, ブランチ) の Revisor PR (open を優先、無ければ決着済み)。 */
  findLocalPrByBranch(repository: string, branch: string): Promise<RevisorLocalPr | null>;
  /**
   * (リポジトリ, セッション) の Revisor PR。共有 checkout (基点ブランチ) で起動し、別の worktree の
   * ブランチから提出したセッションの担当 PR をこれで引く。無ければ branch だけで探す。
   */
  findLocalPrBySession?(repository: string, sessionId: string): Promise<RevisorLocalPr | null>;
  /** 委託 run (終端かどうかを読む)。無ければ run の終端は照会できない扱い。 */
  findRun?(runId: string): ReapRun | null;
  /** 最新の未回答の質問カードを出した時刻 (秒)。無ければ null。 */
  latestUnansweredQuestionTs?(sessionId: string): number | null;
  git: ReaperGitRunner;
}

function sync<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

async function settle<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

function hasOpenReviewPr(open: readonly RevisorLocalPr[], session: SessionRow): boolean {
  if (open.some((pr) => pr.sessionId === session.id)) return true;
  if (!session.repo_origin || !session.branch) return false;
  return matchLocalPrByBranch(open, session.repo_origin, session.branch) !== null;
}

/**
 * 未コミットの変更、または main より先にあって HEAD を提出していないコミットがあるか。
 * git が読めない・提出先を引けないときは null。
 */
async function hasUnsavedWork(ports: ReaperFactPorts, session: SessionRow): Promise<boolean | null> {
  // 共有 checkout (基点ブランチ) の未追跡ファイルと submodule の差分は他の作業の残りで、
  // このセッションの成果ではない。追跡ファイルの変更だけを未保存とみなす。
  const shared = !session.branch || BASE_BRANCHES.has(session.branch);
  const statusArgs = shared
    ? ["status", "--porcelain", "--untracked-files=no", "--ignore-submodules=all"]
    : ["status", "--porcelain"];
  const status = await settle(() => ports.git(session.repo_path, statusArgs));
  if (!status?.ok) return null;
  if (status.stdout.trim()) return true;
  const ahead = await settle(() => ports.git(session.repo_path, ["rev-list", "--count", "main..HEAD"]));
  if (!ahead?.ok) return null;
  const count = Number(ahead.stdout.trim());
  if (!Number.isFinite(count)) return null;
  if (count === 0) return false;
  const head = await settle(() => ports.git(session.repo_path, ["rev-parse", "HEAD"]));
  if (!head?.ok || !session.repo_origin || !session.branch) return null;
  let pr: RevisorLocalPr | null;
  try {
    pr = await ports.findLocalPrByBranch(session.repo_origin, session.branch);
  } catch {
    return null;
  }
  // HEAD を head にした PR (審査中でも決着済みでも) が無ければ未提出のコミットがある。
  return !pr || pr.headSha !== head.stdout.trim();
}

/**
 * 担当 PR。作業ブランチならブランチで、共有 checkout (基点ブランチ) ならセッションで引く。
 * 引けなければ undefined (照会できない)、PR が無ければ null。
 */
async function assignedPr(ports: ReaperFactPorts, session: SessionRow): Promise<RevisorLocalPr | null | undefined> {
  if (!session.repo_origin) return undefined;
  try {
    if (session.branch && !BASE_BRANCHES.has(session.branch)) {
      const byBranch = await ports.findLocalPrByBranch(session.repo_origin, session.branch);
      if (byBranch || !ports.findLocalPrBySession) return byBranch;
    }
    if (!ports.findLocalPrBySession) return session.branch ? null : undefined;
    return await ports.findLocalPrBySession(session.repo_origin, session.id);
  } catch {
    return undefined;
  }
}

/** 委託 run が終端か。run を読めなければ null。 */
function runTerminal(ports: ReaperFactPorts, runId: string | null): boolean | null {
  if (!runId || !ports.findRun) return null;
  const run = sync(() => ports.findRun!(runId));
  if (!run || typeof run.status !== "string") return null;
  return TERMINAL_RUN_STATUSES.has(run.status);
}

/** 未回答の質問カードを出した後も、セッションが作業を続けたか (古いカード)。 */
function staleQuestionOnly(ports: ReaperFactPorts, sessionId: string, lastActivity: number | null): boolean {
  if (!ports.latestUnansweredQuestionTs || lastActivity === null) return false;
  const askedAt = sync(() => ports.latestUnansweredQuestionTs!(sessionId));
  return askedAt !== null && lastActivity >= askedAt + REAP_STALE_QUESTION_ACTIVITY_SEC;
}

export async function gatherReapInput(
  ports: ReaperFactPorts,
  session: SessionRow,
  link: ChildLink | ReapTarget,
  nowSec: number,
): Promise<ReapInput> {
  const last = sync(() => ports.lastActivitySec(session.id));
  const open = await settle(() => ports.listOpenLocalPrs());
  const blockers: ReapBlockers = {
    humanWait: sync(() => ports.isHumanWaitActive(session.id)),
    pendingQuestion: sync(() => ports.hasPendingQuestion(session.id)),
    waitingHumanResponse: sync(() => ports.isWaitingForHumanResponse(session.id)),
    askMarker: await settle(() => ports.isAwaitingAsk(session)),
    openReviewPr: open === null ? null : hasOpenReviewPr(open, session),
    testingClaim: sync(() => ports.hasTestingClaim(session.id, nowSec)),
    unsavedWork: await hasUnsavedWork(ports, session),
  };
  const pr = await assignedPr(ports, session);
  const prMerged = pr === undefined ? null : pr?.status === "merged";
  const prSettled = pr === undefined ? null : pr !== null && (pr.status === "merged" || pr.status === "closed");
  const terminal = link.kind === "delegation" ? runTerminal(ports, link.runId) : null;
  return {
    kind: link.kind,
    idleSec: last === null ? null : Math.max(0, nowSec - last),
    unchangedCount: sync(() => ports.unchangedCount(session)) ?? 0,
    delegationDone: link.kind === "delegation" && link.runId && link.parentSessionId
      ? sync(() => ports.parentReceivedRunTerminal(link.parentSessionId!, link.runId!))
      : null,
    repoAgentPrMerged: link.kind === "delegation" ? null : prMerged,
    runSettled: terminal === null || prSettled === null ? null : terminal && prSettled,
    staleQuestionOnly: blockers.pendingQuestion === true && staleQuestionOnly(ports, session.id, last),
    blockers,
  };
}
