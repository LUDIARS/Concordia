/**
 * 自動確認の「前回から動いたか」の記録 (2026-11-16 neco 指示
 * 「自動確認は止めずに進捗を記録する。前回と作業状態が変わらない場合は確認はするが Discord へは報告しない」
 * 「自動確認の更新判定も管制と同じようにやって」)。
 *
 * 指紋は追跡状態 (state・タスク。ほぼ unknown で空) ではなく、観測された実際の動き
 * (会話・HEAD/作業ツリー・PR/委託・サイドチャンネル現況) から session-activity.ts の純関数で作る。
 * 管制の停止判定も同じ記録と同じ基準を読む。記録はセッション metadata `cc_followup_progress` に置き、
 * キーを消せば次の自動確認は「変化あり」として従来どおり通知する。state は表示用に別に持つ (指紋には入れない)。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionFollowupSnapshot, SessionFollowupState } from "./session-followup-state.js";
import {
  activityFingerprint,
  classifyActivity,
  conversationActivityMark,
  type ActivityProgress,
} from "./session-activity.js";
import type { ObservedGitActivity } from "./session-activity-observe.js";

export const FOLLOWUP_PROGRESS_KEY = "cc_followup_progress";

/** 作業状態が変わらない回に AI が返す一行。チャット面 (Discord / Slack) へは流さない。 */
export const FOLLOWUP_NO_CHANGE_REPLY = "[変化なし]";

export interface FollowupProgressRecord extends ActivityProgress {
  /** 表示用の追跡状態 (指紋には入れない)。 */
  state?: SessionFollowupState | string;
}

export interface FollowupActivityInput {
  tail: string | null;
  lastActivityMs: number | null;
  nudgeSentinel: string;
  git: ObservedGitActivity | null;
  snapshot: SessionFollowupSnapshot | undefined;
  sideReportedAt: number | null;
}

/** 観測された動きの指紋。PR・委託は照会できた回だけ状態を並べる。 */
export function followupActivityFingerprint(input: FollowupActivityInput): string {
  return activityFingerprint({
    conversation: conversationActivityMark(input.tail, input.lastActivityMs, input.nudgeSentinel),
    head: input.git?.head ?? null,
    worktree: input.git?.worktree ?? null,
    prs: input.snapshot?.prs.map((pr) => `${pr.status}:${pr.checkStatus}`) ?? [],
    delegations: input.snapshot?.delegations.map((run) => run.status) ?? [],
    sideReportedAt: input.sideReportedAt,
  });
}

/** 保存済みの記録。不正値は null (= 初回扱い)。 */
export function readFollowupProgress(metadata: string | null): FollowupProgressRecord | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[FOLLOWUP_PROGRESS_KEY];
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.fingerprint !== "string") return null;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      fingerprint: record.fingerprint,
      unchanged_count: Math.floor(num(record.unchanged_count)),
      last_checked_at: num(record.last_checked_at),
      last_changed_at: num(record.last_changed_at),
      ...(typeof record.state === "string" ? { state: record.state } : {}),
    };
  } catch {
    return null;
  }
}

/** 前回の記録と比べた結果 (管制と共通の classifyActivity)。記録が無ければ変化ありとする。 */
export function nextFollowupProgress(
  previous: FollowupProgressRecord | null, fingerprint: string, nowMs: number,
): FollowupProgressRecord {
  return classifyActivity(previous, fingerprint, nowMs);
}

/** 自動確認を送った回の動きを記録し、前回から変わったかを返す。 */
export function recordFollowupProgress(
  repo: Pick<SessionsRepo, "updateMetadata">, sessionId: string, fingerprint: string, nowMs: number,
  state?: SessionFollowupState,
): { changed: boolean; unchangedCount: number } {
  let next: FollowupProgressRecord = { fingerprint, unchanged_count: 0, last_checked_at: nowMs, last_changed_at: nowMs };
  repo.updateMetadata(sessionId, (metadata) => {
    next = nextFollowupProgress(readFollowupProgress(JSON.stringify(metadata)), fingerprint, nowMs);
    if (state) next = { ...next, state };
    return { ...metadata, [FOLLOWUP_PROGRESS_KEY]: next };
  });
  return { changed: next.unchanged_count === 0, unchangedCount: next.unchanged_count };
}

/** 変化が無い回の本文に添える案内。 */
export function renderFollowupNoChangeNotice(): string[] {
  return [
    `前回の自動確認から観測できる動き (会話・コミット・作業ツリー・PR・委託・現況報告) はありません。確認と実行可能な作業は続け、報告することが無ければ返信は \`${FOLLOWUP_NO_CHANGE_REPLY}\` の一行だけにしてください。`,
  ];
}

/** assistant の発言が「変化なし」の一行だけか。 */
export function isFollowupNoChangeReply(content: string | null | undefined): boolean {
  return (content ?? "").trim() === FOLLOWUP_NO_CHANGE_REPLY;
}
