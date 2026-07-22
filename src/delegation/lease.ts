import type { DelegationRunRow } from "../db/delegation-repo.js";

export const QUEUE_CLAIM_LEASE_MS = 5 * 60_000;

export interface DelegationQueueClaim {
  owner: string;
  fencingToken: number;
}

export function delegationQueueClaim(run: DelegationRunRow): DelegationQueueClaim {
  if (run.status !== "launching" || !run.queue_owner || !run.queue_fencing_token) {
    throw new Error(`delegation run is not owned by a fenced queue claim: ${run.id}`);
  }
  return { owner: run.queue_owner, fencingToken: run.queue_fencing_token };
}
