/**
 * 状態 unknown の自動確認を同じ内容で繰り返さない (2026-10-23 不具合 162bc3a6)。
 *
 * Actio タスクを関連付けできないセッションでは、自動確認が state=unknown を同じ本文で
 * 3 アウトまで繰り返していた。unknown の中身 (タスクの unknown 理由・関連付けできなかった参照・
 * 取れなかった取得元) を鍵にして、同じ鍵の unknown は一度だけ示す。中身が変わるか、
 * unknown 以外の状態で自動確認を一度送れば、次の unknown はまた一度示す。
 *
 * @implements spec/feature/task-linked-followup.md — unknown の理由を一度示す
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionFollowupSnapshot, SessionFollowupState } from "./session-followup-state.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:cc3f1e05 */
import augurContract_4fc26664 from './unknown-followup-key.contract.js'; /* augur-inject:contract-predicate:d077284d */
import augurContract_46cfc5db from './unknown-followup-shown.contract.js'; /* augur-inject:contract-predicate:1c578b6c */

export const UNKNOWN_FOLLOWUP_NOTICE_KEY = "cc_followup_unknown_notice";

/** unknown の中身を表す鍵。unknown 以外の状態では null。入力が同じなら同じ鍵になる。 */
export function unknownFollowupNoticeKey(
  state: SessionFollowupState, snapshot: SessionFollowupSnapshot | undefined,
): string | null {
  if (state !== "unknown") return null;
  if (!snapshot) return JSON.stringify(["snapshot_unavailable"]);
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  return JSON.stringify([
    sorted(snapshot.tasks.filter((task) => task.status === "unknown").map((task) => task.reason ?? "")),
    sorted((snapshot.linkFailures ?? []).map((failure) => `${failure.task_reference}:${failure.reason}`)),
    sorted(snapshot.unavailable ?? []),
  ]);
}
// @ts-expect-error augur-inject
unknownFollowupNoticeKey = contract(unknownFollowupNoticeKey, { ...augurContract_4fc26664, contractId: 'actio-link-C-2', mode: 'observe', sample: 1, where: 'src/control/unknown-followup-notice.ts:17', rule: 'contract-wrap', id: '4fc26664' }); /* augur-inject:contract-wrap:4fc26664 */

/** 同じ中身の unknown を示し済みなら送らない。 */
export function isUnknownFollowupAlreadyShown(key: string | null, shown: string | null): boolean {
  return key !== null && key === shown;
}
// @ts-expect-error augur-inject
isUnknownFollowupAlreadyShown = contract(isUnknownFollowupAlreadyShown, { ...augurContract_46cfc5db, contractId: 'actio-link-C-3', mode: 'observe', sample: 1, where: 'src/control/unknown-followup-notice.ts:31', rule: 'contract-wrap', id: '46cfc5db' }); /* augur-inject:contract-wrap:46cfc5db */

export function readUnknownFollowupNotice(metadata: string | null): string | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[UNKNOWN_FOLLOWUP_NOTICE_KEY];
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

/** 示した unknown の鍵を残す。null は「unknown 以外を通った」記録として消す。 */
export function writeUnknownFollowupNotice(
  repo: Pick<SessionsRepo, "updateMetadata">, sessionId: string, key: string | null, current: string | null,
): void {
  if (key === current) return;
  repo.updateMetadata(sessionId, (metadata) => {
    const next = { ...metadata };
    if (key === null) delete next[UNKNOWN_FOLLOWUP_NOTICE_KEY];
    else next[UNKNOWN_FOLLOWUP_NOTICE_KEY] = key;
    return next;
  });
}
