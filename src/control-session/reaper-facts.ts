/**
 * 子セッションを閉じてよいかの判定に使う事実を、既存の所有者から読み集める。
 * 照会に失敗したものは null にし、判定 (reaper-policy) が「閉じない」に倒す。
 *
 * @implements spec/feature/control-session.md — 9. 子セッションの片付け / CC-CTL-INV-08
 */
import type { RevisorLocalPr } from "../pr/revisor-local-pr-types.js";
import { matchLocalPrByBranch } from "../pr/revisor-branch-lookup.js";
import type { SessionRow } from "../shared/types.js";
import type { ChildLink, ReapBlockers, ReapInput, ReapKind } from "./reaper-policy.js";

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
  const status = await settle(() => ports.git(session.repo_path, ["status", "--porcelain"]));
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

async function repoAgentPrMerged(ports: ReaperFactPorts, session: SessionRow): Promise<boolean | null> {
  if (!session.repo_origin || !session.branch) return null;
  try {
    const pr = await ports.findLocalPrByBranch(session.repo_origin, session.branch);
    return pr?.status === "merged";
  } catch {
    return null;
  }
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
  return {
    kind: link.kind,
    idleSec: last === null ? null : Math.max(0, nowSec - last),
    unchangedCount: sync(() => ports.unchangedCount(session)) ?? 0,
    delegationDone: link.kind === "delegation" && link.runId && link.parentSessionId
      ? sync(() => ports.parentReceivedRunTerminal(link.parentSessionId!, link.runId!))
      : null,
    repoAgentPrMerged: link.kind === "repo-agent" || link.kind === "standalone" ? await repoAgentPrMerged(ports, session) : null,
    blockers,
  };
}
