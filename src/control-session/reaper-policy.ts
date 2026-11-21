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
/** 案内の後にこれより遅れて会話があれば「反応した」とみなし、案内からやり直す。 */
export const REAP_NOTICE_RESPONSE_SEC = 60;
/** 未回答の質問カードを出した後、これ以上作業を続けていれば古いカードとみなす。 */
export const REAP_STALE_QUESTION_ACTIVITY_SEC = 10 * 60;
/**
 * 作業が終わった根拠があり、これだけ動きが無ければ、質問カード・人間の応答待ち・ask マーカーが
 * 残っていても閉じる (2026-11-21 neco 指示「タスク完了かつ無活動 … 質問カード待ち・人間の応答待ちでも閉じる」)。
 */
export const REAP_DONE_LONG_IDLE_SEC = 2 * 60 * 60;
/** 終わった後に長く動きが無ければ待ちに数えない待ち。human-wait (人間の判断の明示記録)・審査中 PR・testing claim・未保存の変更は数える。 */
export const REAP_LONG_IDLE_IGNORED_WAITS: ReadonlySet<keyof ReapBlockers> = new Set(["pendingQuestion", "waitingHumanResponse", "askMarker"]);

/** 委託 run の終端。 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "partial", "failed"]);

export type ChildKind = "repo-agent" | "delegation" | "spawn";
/** 親の記録が無いセッション (人間が起動したものなど)。担当 PR のマージ済みだけで終了候補になる。 */
export type ReapKind = ChildKind | "standalone";

export interface ChildLink {
  kind: ChildKind;
  /** 親セッション。委託 run の子で、親を記録から引けなければ null。 */
  parentSessionId: string | null;
  /** 委託 run の子なら run id。 */
  runId: string | null;
}

/** 片付けが読む委託 run の列。 */
export interface ReapRun {
  child_session_id: string | null;
  parent_session_id: string | null;
  /** 起動元。セッションから委託したものはセッション id が入る (parent_session_id が空のことがある)。 */
  triggered_by?: string | null;
  status?: string | null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const SESSION_ID_TRIGGER = /^lictor-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 委託 run の親セッション。parent_session_id → セッション metadata → 起動元 (triggered_by が
 * セッション id のとき) の順。cron 等の起動元は親にしない。
 */
export function runParentSessionId(run: ReapRun, metadata: Record<string, unknown>): string | null {
  const trigger = str(run.triggered_by);
  return str(run.parent_session_id)
    ?? str(metadata.delegation_parent_session_id)
    ?? (trigger && SESSION_ID_TRIGGER.test(trigger) ? trigger : null);
}

/**
 * セッション metadata から親子の記録を引く。記録が無ければ null (= 対象外)。
 * 委託 run は run 側の child_session_id と一致するときだけ子とみなす。
 */
export function classifyChild(input: {
  sessionId: string;
  metadata: Record<string, unknown>;
  findRun(runId: string): ReapRun | null;
}): ChildLink | null {
  const repoAgentOf = input.metadata.repo_agent_of as Record<string, unknown> | undefined;
  const repoAgentParent = repoAgentOf && typeof repoAgentOf === "object" ? str(repoAgentOf.parent_session_id) : null;
  if (repoAgentParent) return { kind: "repo-agent", parentSessionId: repoAgentParent, runId: null };
  const runId = str(input.metadata.delegation_run_id);
  if (runId) {
    const run = input.findRun(runId);
    if (!run || run.child_session_id !== input.sessionId) return null;
    // 親を引けない委託の子も対象にする (run の終端と担当 PR の決着で閉じる)。
    return { kind: "delegation", parentSessionId: runParentSessionId(run, input.metadata), runId };
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
export type ReapReason =
  | "done_delegation"
  | "done_run_settled"
  | "done_repo_agent"
  | "done_merged"
  | "done_task"
  | "unresponsive";

const REAP_REASONS: readonly ReapReason[] = ["done_delegation", "done_run_settled", "done_repo_agent", "done_merged", "done_task", "unresponsive"];

/** 作業が終わった根拠で閉じる理由 (古い質問カードを待ちに数えないのはこれだけ)。 */
export function isDoneReason(reason: ReapReason): boolean {
  return reason !== "unresponsive";
}

/**
 * 親の記録が無いセッションを終了候補の対象にしてよいか。担当ブランチがあり基点ブランチでないもの、
 * または Actio タスクが紐付いているもの (基点ブランチの会話セッションもタスクの完了で閉じられる)。
 */
export function isStandaloneReapTarget(
  session: { repo_origin: string | null; branch: string | null }, hasTaskLinks = false,
): boolean {
  if (hasTaskLinks) return true;
  return !!session.repo_origin && !!session.branch && !["main", "master", "develop"].includes(session.branch);
}

export interface ReapInput {
  kind: ReapKind;
  /** 最後の会話からの経過秒。分からなければ null。 */
  idleSec: number | null;
  unchangedCount: number;
  /** 委託 run が終端で、親が終端の通知を受け取った記録がある。照会できなければ null。 */
  delegationDone: boolean | null;
  /** 担当 PR が merged (repo-agent / spawn / standalone)。照会できなければ null。 */
  repoAgentPrMerged: boolean | null;
  /** 委託 run が終端 (completed / partial / failed) で、担当 PR がマージ済みかクローズ済み。照会できなければ null。 */
  runSettled?: boolean | null;
  /** 紐付く Actio タスクがすべて完了 (done / cancelled)。紐付けが無い・照会できなければ null。 */
  linkedTasksDone?: boolean | null;
  /** 未回答の質問カードはあるが、出した後もセッションが作業を続けた (古いカード)。 */
  staleQuestionOnly?: boolean;
  blockers: ReapBlockers;
}

export type ReapVerdict =
  | { eligible: true; reason: ReapReason; staleQuestion?: boolean; longIdleWaits?: boolean }
  | { eligible: false; reason: "not_due" | ReapBlockReason };

export function firstBlocker(
  blockers: ReapBlockers, ignore: ReadonlySet<keyof ReapBlockers> = new Set(),
): ReapBlockReason | null {
  for (const key of Object.keys(blockers) as Array<keyof ReapBlockers>) {
    if (ignore.has(key)) continue;
    if (blockers[key] === null) return `${key}_unknown`;
    if (blockers[key]) return key;
  }
  return null;
}

function dueReason(input: ReapInput): ReapReason | null {
  if (input.idleSec === null) return null;
  const doneIdle = input.idleSec >= REAP_DONE_IDLE_SEC;
  if (input.kind === "delegation" && input.delegationDone === true && doneIdle) return "done_delegation";
  if (input.kind === "delegation" && input.runSettled === true && doneIdle) return "done_run_settled";
  if (input.kind === "repo-agent" && input.repoAgentPrMerged === true && doneIdle) return "done_repo_agent";
  if (input.kind === "spawn" && input.repoAgentPrMerged === true && doneIdle) return "done_merged";
  // 紐付く Actio タスクの完了は、親子の記録の有無にかかわらず終わった根拠にする (2026-11-21)。
  if (input.linkedTasksDone === true && doneIdle && !(input.kind === "standalone" && input.repoAgentPrMerged === true)) return "done_task";
  if (input.kind === "standalone") {
    // 人間が起動したものは「反応しない」では閉じない (担当作業の完了だけを根拠にする)。
    return input.repoAgentPrMerged === true && input.idleSec >= REAP_DONE_IDLE_SEC ? "done_merged" : null;
  }
  if (input.idleSec >= REAP_UNRESPONSIVE_IDLE_SEC && input.unchangedCount >= REAP_UNRESPONSIVE_UNCHANGED_MIN) return "unresponsive";
  return null;
}

/**
 * 閉じてよいか。待ち・未保存の変更・照会できない事実が 1 つでもあれば閉じない。
 * 古い質問カード (出した後も作業を続けた) だけが残っているときは、作業が終わった根拠が
 * あるときに限り待ちに数えない。根拠が「反応しない」だけなら人の回答待ちとして閉じない。
 */
export function decideReap(input: ReapInput): ReapVerdict {
  const reason = dueReason(input);
  if (!reason) return { eligible: false, reason: "not_due" };
  const staleQuestion = input.staleQuestionOnly === true && input.blockers.pendingQuestion === true && isDoneReason(reason);
  // 終わった根拠があって 2 時間動きが無ければ、質問カード・応答待ち・ask マーカーは待ちに数えない。
  const longIdle = isDoneReason(reason) && input.idleSec !== null && input.idleSec >= REAP_DONE_LONG_IDLE_SEC;
  if (longIdle) {
    const blocked = firstBlocker(input.blockers, REAP_LONG_IDLE_IGNORED_WAITS);
    if (blocked) return { eligible: false, reason: blocked };
    // 古い質問カードで説明がつく待ちはその説明を優先し、それ以外に残った待ちがあるときだけ長い無活動を理由にする。
    const longIdleWaits = [...REAP_LONG_IDLE_IGNORED_WAITS]
      .some((key) => input.blockers[key] !== false && !(key === "pendingQuestion" && staleQuestion));
    return {
      eligible: true, reason,
      ...(staleQuestion ? { staleQuestion: true } : {}),
      ...(longIdleWaits ? { longIdleWaits: true } : {}),
    };
  }
  const blocked = firstBlocker(input.blockers, staleQuestion ? new Set(["pendingQuestion"]) : new Set());
  if (blocked) return { eligible: false, reason: blocked };
  return staleQuestion ? { eligible: true, reason, staleQuestion: true } : { eligible: true, reason };
}

export interface ReapNoticeState {
  noticed_at: number;
  reason: ReapReason;
  end_attempted_at: number | null;
}

export type ReapStep = "none" | "notice" | "wait_grace" | "end" | "end_attempted";

/**
 * 2 段の段取り: 案内を 1 回 → 猶予後も閉じてよく、案内に反応が無ければ終了 → 終了を試みたら再送しない。
 * 案内の後に会話があれば (反応した) 案内からやり直す。
 */
export function nextReapStep(
  verdict: ReapVerdict, state: ReapNoticeState | null, nowSec: number, lastActivitySec: number | null = null,
): ReapStep {
  if (state?.end_attempted_at) return "end_attempted";
  if (!verdict.eligible) return "none";
  if (!state) return "notice";
  if (lastActivitySec !== null && lastActivitySec > state.noticed_at + REAP_NOTICE_RESPONSE_SEC) return "notice";
  return nowSec - state.noticed_at >= REAP_NOTICE_GRACE_SEC ? "end" : "wait_grace";
}

export const REAP_STATE_METADATA_KEY = "control_reaper";

export function parseReapState(value: unknown): ReapNoticeState | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || typeof raw.noticed_at !== "number") return null;
  const reason = raw.reason;
  if (typeof reason !== "string" || !REAP_REASONS.includes(reason as ReapReason)) return null;
  return {
    noticed_at: raw.noticed_at,
    reason: reason as ReapReason,
    end_attempted_at: typeof raw.end_attempted_at === "number" ? raw.end_attempted_at : null,
  };
}
