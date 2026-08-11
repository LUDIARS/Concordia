/**
 * Durable parent/child session links for a claimed delegation run.
 *
 * The caller provides D1's projector entrypoint so both messages use the
 * canonical session_messages stream rather than a parallel persistence path.
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { ConcordiaEvent } from "../events.js";

export interface DelegationLinkProjector {
  (event: ConcordiaEvent): void;
}

export function projectDelegationSessionLinks(
  run: Pick<DelegationRunRow, "id" | "parent_session_id" | "child_session_id">,
  project: DelegationLinkProjector,
  ts: number,
): boolean {
  if (!run.parent_session_id || !run.child_session_id) return false;

  const metadata = {
    run_id: run.id,
    parent_session_id: run.parent_session_id,
    child_session_id: run.child_session_id,
  };

  project({
    type: "delegation.mirror",
    target_session_id: run.parent_session_id,
    ...metadata,
    link_side: "parent",
    text: `子: ${run.child_session_id} / run: ${run.id}`,
    ts,
  });
  project({
    type: "delegation.mirror",
    target_session_id: run.child_session_id,
    ...metadata,
    link_side: "child",
    text: `親: ${run.parent_session_id} / run: ${run.id}`,
    ts,
  });
  return true;
}
