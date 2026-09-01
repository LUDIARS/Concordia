import type { DelegationRunRow } from "../db/delegation-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";

export interface DelegationRunEventSink {
  emit(event: ConcordiaEvent): void;
}

/** Delegation run の変更を platform-neutral event として通知する。 */
export function emitDelegationRunChanged(
  run: Pick<DelegationRunRow, "id" | "parent_session_id" | "status"> | null,
  sink: DelegationRunEventSink = eventBus,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): boolean {
  if (!run) return false;
  sink.emit({
    type: "delegation.run_changed",
    parent_session_id: run.parent_session_id ?? null,
    run_id: run.id,
    status: run.status,
    ts: nowSec(),
  });
  return true;
}
