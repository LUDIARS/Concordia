import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import { ActioTaskError, type ActioTaskClient } from "./actio-client.js";
import type { CcTaskRepository } from "./repository.js";
import type { CcTaskSyncState } from "./types.js";

const log = createChildLogger("fallback-task-sync");

/** @implements spec/feature/cc-task-fallback.md */
export async function syncOneTask(repo: CcTaskRepository, actio: ActioTaskClient): Promise<boolean> {
  const candidate = repo.nextForSync();
  if (!candidate) return false;
  const wasUnknown = candidate.actio_sync_state === "unknown";
  if (!wasUnknown && !repo.claim(candidate.id)) return true;
  let expectedState: CcTaskSyncState = wasUnknown ? "unknown" : "checking";
  try {
    const existing = await actio.findByConcordiaId(candidate.id);
    if (existing) {
      await actio.update(existing.id, candidate);
      // PATCH may have changed the local row while the network calls were in flight.
      // Only the exact state claimed above may be completed; a newer pending row must win.
      repo.setSync(candidate.id, expectedState, "synced", {
        actioTaskId: existing.id,
        expectedUpdatedAt: candidate.updated_at,
      });
      return true;
    }
    // POST の成否が不明な行は照合だけを繰り返す。見つからないことを理由に再 POST しない。
    if (wasUnknown) {
      // Move this row behind other unknown outcomes so one unresolved task cannot starve the queue.
      repo.setSync(candidate.id, "unknown", "unknown", {
        error: candidate.actio_sync_error,
        expectedUpdatedAt: candidate.updated_at,
      });
      return false;
    }
    // No POST is issued unless the lookup claim is still current. A concurrent local PATCH
    // returns checking to pending and wins this transition.
    if (!repo.beginCreate(candidate.id)) return true;
    expectedState = "creating";
    const created = await actio.create(candidate);
    if (!repo.setSync(candidate.id, "creating", "synced", {
      actioTaskId: created.id,
      expectedUpdatedAt: candidate.updated_at,
    })) {
      // A local edit during POST changes creating to unknown. Creation is now known to have
      // succeeded, so retain the remote id and queue the newer local content for PATCH.
      repo.setSync(candidate.id, "unknown", "pending", { actioTaskId: created.id });
    }
  } catch (error) {
    const outcome = error instanceof ActioTaskError ? error.outcome : "unknown";
    // Once POST may have reached Actio, no lookup failure may make the row eligible for POST again.
    const state = wasUnknown
      ? "unknown"
      : outcome === "rejected" ? "failed" : outcome === "unavailable" ? "pending" : "unknown";
    const publicError = error instanceof ActioTaskError ? error.message : "Unexpected Actio synchronization failure";
    if (!repo.setSync(candidate.id, expectedState, state, {
      error: publicError,
      expectedUpdatedAt: candidate.updated_at,
    })
      && expectedState === "creating") {
      // A concurrent PATCH changed creating to unknown. A rejected POST has a known outcome;
      // all other create failures remain unknown and must never become POST-eligible.
      const concurrentState = outcome === "rejected"
        ? "failed"
        : outcome === "unavailable" ? "pending" : "unknown";
      repo.setSync(candidate.id, "unknown", concurrentState, { error: publicError });
    }
    if (state !== "pending") log.warn({ task_id: candidate.id, error }, "Actio task sync did not complete");
  }
  return true;
}

/** @implements spec/feature/cc-task-fallback.md */
export function startCcTaskSync(input: { repo: CcTaskRepository; actio: ActioTaskClient; intervalMs?: number }): { stop(): void } {
  input.repo.recoverInterruptedClaims();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await syncOneTask(input.repo, input.actio); }
    finally { running = false; }
  };
  const supervised = startSupervisedInterval("cc-task-actio-sync", tick, {
    intervalMs: input.intervalMs ?? 30_000,
    initialDelayMs: 0,
    log: { warn: (message) => log.warn(message) },
  });
  return { stop: supervised.stop };
}
