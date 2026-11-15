/**
 * 自動確認の作業状態の指紋と、前回からの変化の記録 (2026-11-16 neco 指示
 * 「自動確認は止めずに進捗を記録する。前回と作業状態が変わらない場合は確認はするが Discord へは報告しない」)。
 *
 * 指紋は Cc が照会した作業状態 (state・Actio タスク・PR・委託・関連付け失敗・取得不能の取得元) だけから作る。
 * 会話の活動時刻は毎回変わるので含めない。記録はセッション metadata `cc_followup_progress` に置き、
 * キーを消せば次の自動確認は「変化あり」として従来どおり通知する。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionFollowupSnapshot, SessionFollowupState } from "./session-followup-state.js";

export const FOLLOWUP_PROGRESS_KEY = "cc_followup_progress";

/** 作業状態が変わらない回に AI が返す一行。チャット面 (Discord / Slack) へは流さない。 */
export const FOLLOWUP_NO_CHANGE_REPLY = "[変化なし]";

export interface FollowupProgressRecord {
  fingerprint: string;
  unchanged_count: number;
  last_checked_at: number;
  last_changed_at: number;
}

/** 作業状態の指紋。並び順に依存しないよう各一覧を正規化してソートする。 */
export function followupProgressFingerprint(
  state: SessionFollowupState, snapshot: SessionFollowupSnapshot | undefined,
): string {
  if (!snapshot) return JSON.stringify({ state, snapshot: null });
  const sorted = (values: readonly string[]) => [...values].sort();
  return JSON.stringify({
    state,
    workflow: snapshot.workflow,
    tasks: sorted(snapshot.tasks.map((task) => `${task.status}:${task.reason ?? ""}`)),
    prs: sorted(snapshot.prs.map((pr) => `${pr.status}:${pr.checkStatus}`)),
    delegations: sorted(snapshot.delegations.map((run) => run.status)),
    linkFailures: sorted((snapshot.linkFailures ?? []).map((failure) => `${failure.task_reference}:${failure.reason}`)),
    unavailable: sorted([...(snapshot.unavailable ?? [])]),
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
    };
  } catch {
    return null;
  }
}

/** 前回の記録と比べた結果。記録が無ければ変化ありとする。 */
export function nextFollowupProgress(
  previous: FollowupProgressRecord | null, fingerprint: string, nowMs: number,
): FollowupProgressRecord {
  if (previous && previous.fingerprint === fingerprint) {
    return { ...previous, unchanged_count: previous.unchanged_count + 1, last_checked_at: nowMs };
  }
  return { fingerprint, unchanged_count: 0, last_checked_at: nowMs, last_changed_at: nowMs };
}

/** 自動確認を送った回の作業状態を記録し、前回から変わったかを返す。 */
export function recordFollowupProgress(
  repo: Pick<SessionsRepo, "updateMetadata">, sessionId: string, fingerprint: string, nowMs: number,
): { changed: boolean; unchangedCount: number } {
  let next: FollowupProgressRecord = { fingerprint, unchanged_count: 0, last_checked_at: nowMs, last_changed_at: nowMs };
  repo.updateMetadata(sessionId, (metadata) => {
    next = nextFollowupProgress(readFollowupProgress(JSON.stringify(metadata)), fingerprint, nowMs);
    return { ...metadata, [FOLLOWUP_PROGRESS_KEY]: next };
  });
  return { changed: next.unchanged_count === 0, unchangedCount: next.unchanged_count };
}

/** 変化が無い回の本文に添える案内。 */
export function renderFollowupNoChangeNotice(): string[] {
  return [
    `前回の自動確認から作業状態は変わっていません。確認と実行可能な作業は続け、報告することが無ければ返信は \`${FOLLOWUP_NO_CHANGE_REPLY}\` の一行だけにしてください。`,
  ];
}

/** assistant の発言が「変化なし」の一行だけか。 */
export function isFollowupNoChangeReply(content: string | null | undefined): boolean {
  return (content ?? "").trim() === FOLLOWUP_NO_CHANGE_REPLY;
}
