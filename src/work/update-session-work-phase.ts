/** @implements CC-SESSION-WORK-PHASES — atomic reporting of the assessed stage. */
// @spec セッションの設計・開始確認・実装・調整
import type { SessionsRepo } from "../db/sessions-repo.js";
import { readSessionWorkPhase, transitionWorkPhase, WORK_PHASE_KEY, WorkPhaseInvalid, type WorkPhaseUpdate, type WorkPhaseView } from "./session-work-phase.js";

type PhaseSessions = Pick<SessionsRepo, "findSession" | "updateMetadata" | "appendEvent">;

export function updateSessionWorkPhase(repo: PhaseSessions, sessionId: string, input: WorkPhaseUpdate, now: number): WorkPhaseView {
  let result: WorkPhaseView | undefined;
  repo.updateMetadata(sessionId, (metadata) => {
    // Both the binding and revision are read under the same immediate transaction.
    const session = repo.findSession(sessionId);
    if (!session) throw new WorkPhaseInvalid("session_not_found");
    if (session.status === "ended" || session.status === "abandoned") throw new WorkPhaseInvalid("session_inactive");
    const record = transitionWorkPhase({ ...session, metadata: JSON.stringify(metadata) }, input, now);
    const next = { ...metadata, [WORK_PHASE_KEY]: record };
    repo.appendEvent({ session_id: sessionId, ts: now, kind: "work_phase_changed", payload: {
      phase: record.phase, revision: record.revision,
      // Evidence remains in the bounded state; timeline does not duplicate human conversation.
    } });
    result = readSessionWorkPhase({ ...session, metadata: JSON.stringify(next) });
    return next;
  });
  if (!result) throw new WorkPhaseInvalid("work_phase_not_saved");
  return result;
}
