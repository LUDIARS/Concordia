/**
 * 作業指示で起動した子セッションを閉じてよいかの純判定。
 * 対象の判定は既存の親子の記録だけを使い、照会できない事実は「閉じない」に倒す。
 *
 * @implements spec/feature/control-session.md — 9. 子セッションの片付け / CC-CTL-INV-08
 */

/** 役目を終えた後、これだけ会話が無ければ閉じる。 */
export const REAP_DONE_IDLE_SEC = 30 * 60;
/** 反応しないとみなす会話の無い時間。 */
export const REAP_UNRESPONSIVE_IDLE_SEC = 60 * 60;
/** 反応しないとみなす、自動確認・追加指示で作業状態が変わらなかった回数。 */
export const REAP_UNRESPONSIVE_UNCHANGED_MIN = 2;
/** 案内してから終了するまでの猶予。 */
export const REAP_NOTICE_GRACE_SEC = 10 * 60;

export type ChildKind = "repo-agent" | "delegation" | "spawn";
/** 親の記録が無いセッション (人間が起動したものなど)。担当 PR のマージ済みだけで終了候補になる。 */
export type ReapKind = ChildKind | "standalone";

export interface ChildLink {
  kind: ChildKind;
  parentSessionId: string;
  /** 委託 run の子なら run id。 */
  runId: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * セッション metadata から親子の記録を引く。記録が無ければ null (= 対象外)。
 * 委託 run は run 側の child_session_id と一致するときだけ子とみなす。
 */
export function classifyChild(input: {
  sessionId: string;
  metadata: Record<string, unknown>;
  findRun(runId: string): { child_session_id: string | null; parent_session_id: string | null } | null;
}): ChildLink | null {
  const repoAgentOf = input.metadata.repo_agent_of as Record<string, unknown> | undefined;
  const repoAgentParent = repoAgentOf && typeof repoAgentOf === "object" ? str(repoAgentOf.parent_session_id) : null;
  if (repoAgentParent) return { kind: "repo-agent", parentSessionId: repoAgentParent, runId: null };
  const runId = str(input.metadata.delegation_run_id);
  if (runId) {
    const run = input.findRun(runId);
    if (!run || run.child_session_id !== input.sessionId) return null;
    const parent = str(run.parent_session_id) ?? str(input.metadata.delegation_parent_session_id);
    return parent ? { kind: "delegation", parentSessionId: parent, runId } : null;
  }
  const spawnParent = str(input.metadata.delegation_parent_session_id);
  return spawnParent ? { kind: "spawn", parentSessionId: spawnParent, runId: null } : null;
}

/** 閉じない理由。照会できないもの (null) も閉じない。 */
export interface ReapBlockers {
  humanWait: boolean | null;
  pendingQuestion: boolean | null;
  waitingHumanResponse: boolean | null;
  askMarker: boolean | null;
  openReviewPr: boolean | null;
  testingClaim: boolean | null;
  unsavedWork: boolean | null;
}

export type ReapBlockReason = keyof ReapBlockers | `${keyof ReapBlockers}_unknown`;
export type ReapReason = "done_delegation" | "done_repo_agent" | "done_merged" | "unresponsive";

/** 親の記録が無いセッションを終了候補の対象にしてよいか (担当ブランチがあり、基点ブランチでない)。 */
export function isStandaloneReapTarget(session: { repo_origin: string | null; branch: string | null }): boolean {
  return !!session.repo_origin && !!session.branch && !["main", "master", "develop"].includes(session.branch);
}

export interface ReapInput {
  kind: ReapKind;
  /** 最後の会話からの経過秒。分からなければ null。 */
  idleSec: number | null;
  unchangedCount: number;
  /** 委託 run が終端で、親が終端の通知を受け取った記録がある。照会できなければ null。 */
  delegationDone: boolean | null;
  /** repo-agent の担当 PR が merged。照会できなければ null。 */
  repoAgentPrMerged: boolean | null;
  blockers: ReapBlockers;
}

export type ReapVerdict =
  | { eligible: true; reason: ReapReason }
  | { eligible: false; reason: "not_due" | ReapBlockReason };

export function firstBlocker(blockers: ReapBlockers): ReapBlockReason | null {
  for (const key of Object.keys(blockers) as Array<keyof ReapBlockers>) {
    if (blockers[key] === null) return `${key}_unknown`;
    if (blockers[key]) return key;
  }
  return null;
}

function dueReason(input: ReapInput): ReapReason | null {
  if (input.idleSec === null) return null;
  if (input.kind === "delegation" && input.delegationDone === true && input.idleSec >= REAP_DONE_IDLE_SEC) return "done_delegation";
  if (input.kind === "repo-agent" && input.repoAgentPrMerged === true && input.idleSec >= REAP_DONE_IDLE_SEC) return "done_repo_agent";
  if (input.kind === "standalone") {
    // 人間が起動したものは「反応しない」では閉じない (担当作業の完了だけを根拠にする)。
    return input.repoAgentPrMerged === true && input.idleSec >= REAP_DONE_IDLE_SEC ? "done_merged" : null;
  }
  if (input.idleSec >= REAP_UNRESPONSIVE_IDLE_SEC && input.unchangedCount >= REAP_UNRESPONSIVE_UNCHANGED_MIN) return "unresponsive";
  return null;
}

/** 閉じてよいか。待ち・未保存の変更・照会できない事実が 1 つでもあれば閉じない。 */
export function decideReap(input: ReapInput): ReapVerdict {
  const reason = dueReason(input);
  if (!reason) return { eligible: false, reason: "not_due" };
  const blocked = firstBlocker(input.blockers);
  if (blocked) return { eligible: false, reason: blocked };
  return { eligible: true, reason };
}

export interface ReapNoticeState {
  noticed_at: number;
  reason: ReapReason;
  end_attempted_at: number | null;
}

export type ReapStep = "none" | "notice" | "wait_grace" | "end" | "end_attempted";

/** 2 段の段取り: 案内を 1 回 → 猶予後も閉じてよければ終了 → 終了を試みたら再送しない。 */
export function nextReapStep(verdict: ReapVerdict, state: ReapNoticeState | null, nowSec: number): ReapStep {
  if (state?.end_attempted_at) return "end_attempted";
  if (!verdict.eligible) return "none";
  if (!state) return "notice";
  return nowSec - state.noticed_at >= REAP_NOTICE_GRACE_SEC ? "end" : "wait_grace";
}

export const REAP_STATE_METADATA_KEY = "control_reaper";

export function parseReapState(value: unknown): ReapNoticeState | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.noticed_at !== "number") return null;
  const reason = raw.reason;
  if (reason !== "done_delegation" && reason !== "done_repo_agent" && reason !== "done_merged" && reason !== "unresponsive") return null;
  return {
    noticed_at: raw.noticed_at,
    reason,
    end_attempted_at: typeof raw.end_attempted_at === "number" ? raw.end_attempted_at : null,
  };
}
