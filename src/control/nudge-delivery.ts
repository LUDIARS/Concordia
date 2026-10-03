/** Delivery suppression is not a human response gate; AI activity reopens it. */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";
export function readNudgeProgress(metadata:string | null): number {
  try { return Number((JSON.parse(metadata ?? "{}") as Record<string,unknown>).cc_nudge_progress_at ?? 0); }
  catch { return 0; }
}
export function startNudgeProgress(repo:Pick<SessionsRepo,"findSession" | "mergeMetadata">): {stop():void} {
  return { stop:eventBus.subscribe((event) => {
    const id = event.type === "delegation.run_changed" ? event.parent_session_id
      : event.type === "taskflow.completion_detected" ? event.session_id
      : event.type === "session.inject" && /^revisor/.test(event.source ?? "") ? event.target_session_id : null;
    if (id && repo.findSession(id)) repo.mergeMetadata(id,{cc_nudge_progress_at:event.ts*1000});
  }) };
}
export function claimNudgeDelivery(repo: Pick<SessionsRepo,"findSession" | "updateMetadata">,
  sessionId: string, activityMs: number, nowMs: number): boolean {
  let claimed = false;
  repo.updateMetadata(sessionId,(metadata) => {
    const last = metadata.cc_nudge_delivery as { activityMs?: number; sentAt?: number } | undefined;
    if (last && typeof last.activityMs === "number" && activityMs <= last.activityMs
      && Number(metadata.cc_nudge_progress_at ?? 0) <= Number(last.sentAt ?? 0)) return metadata;
    claimed = true;
    return { ...metadata,cc_nudge_delivery:{ activityMs,sentAt:nowMs } };
  });
  return claimed;
}
