import type { TestingClaimsRepo, TestClaimRow } from "../db/testing-claims-repo.js";
import { eventBus } from "../events.js";

export interface OpenTestingClaimInput {
  service: string;
  sessionId: string;
  branch?: string | null;
  note?: string;
  now: number;
}

export interface ReleaseTestingClaimsInput {
  sessionId: string;
  service?: string | null;
  now: number;
}

/**
 * testing claim の永続化と公開 lifecycle event を同じ境界で扱う。
 * API、confirm flow、session 終了時解放のどの入口でも投稿漏れを起こさないため、
 * TestingClaimsRepo を直接操作せずこの関数を使う。
 */
export function openTestingClaim(
  repo: TestingClaimsRepo,
  input: OpenTestingClaimInput,
): ReturnType<TestingClaimsRepo["claim"]> {
  const replaced = repo.listActive(input.now).filter(
    (claim) => claim.session_id === input.sessionId && claim.service === input.service,
  );
  const result = repo.claim({
    service: input.service,
    session_id: input.sessionId,
    branch: input.branch,
    note: input.note,
    now: input.now,
  });

  for (const claim of replaced) emitReleased(claim, input.now);
  eventBus.emit({
    type: "operational.claim.opened",
    target_session_id: result.claim.session_id,
    claim_kind: "testing",
    claim_id: result.claim.id,
    resource: result.claim.service,
    branch: result.claim.branch,
    note: result.claim.note,
    conflict_session_ids: result.conflicts.map((claim) => claim.session_id),
    started_at: result.claim.started_at,
    ts: input.now,
  });
  return result;
}

/**
 * active な claim を解放し、解放できた各 claim を個別イベントとして公開する。
 * TTL 超過済みの残骸は利用者向け現況ではないため投稿対象にしない。
 */
export function releaseTestingClaims(
  repo: TestingClaimsRepo,
  input: ReleaseTestingClaimsInput,
): number {
  const active = repo.listActive(input.now).filter(
    (claim) => claim.session_id === input.sessionId &&
      (input.service == null || claim.service === input.service),
  );
  const released = repo.release(input.sessionId, input.service ?? null, input.now);
  for (const claim of active) emitReleased(claim, input.now);
  return released;
}

function emitReleased(claim: TestClaimRow, now: number): void {
  eventBus.emit({
    type: "operational.claim.released",
    target_session_id: claim.session_id,
    claim_kind: "testing",
    claim_id: claim.id,
    resource: claim.service,
    branch: claim.branch,
    note: claim.note,
    started_at: claim.started_at,
    ts: now,
  });
}
