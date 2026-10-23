/** Provider task states published by the Codex Cloud CLI (`TaskStatus`, kebab-case). */
export type RemoteTaskStatus = "pending" | "ready" | "applied" | "error";

export interface AttemptJournal {
  intent: boolean;
  receipt: { state: "submitted"; remoteId: string } | { state: "submission_unknown" } | null;
  reconciliationRemoteId: string | null;
  verified: boolean;
}

/**
 * queued: never submitted. unknown: intent exists without a known provider task.
 * running: provider task known, pending or not observed. remote_ready / remote_error:
 * provider finished; this is not artifact receipt, review or acceptance.
 */
export type ShardPhase = "queued" | "unknown" | "running" | "remote_ready" | "remote_error" | "collected";

export function remoteIdOf(journal: AttemptJournal): string | null {
  if (journal.receipt?.state === "submitted") return journal.receipt.remoteId;
  return journal.reconciliationRemoteId;
}

export function shardPhase(journal: AttemptJournal, observed: ReadonlyMap<string, RemoteTaskStatus>): ShardPhase {
  if (!journal.intent) return "queued";
  if (journal.verified) return "collected";
  const remoteId = remoteIdOf(journal);
  if (!remoteId) return "unknown";
  const status = observed.get(remoteId);
  if (status === "ready" || status === "applied") return "remote_ready";
  if (status === "error") return "remote_error";
  return "running";
}

/** Unknown and unobserved work may still consume provider capacity, so it keeps its slot. */
export function occupiesSlot(phase: ShardPhase): boolean {
  return phase === "unknown" || phase === "running";
}

/** Indices to submit now, lowest first. A stopped batch never starts new shards. */
export function selectShardsToKick(phases: readonly ShardPhase[], concurrency: number, stopped: boolean): number[] {
  if (stopped) return [];
  const free = concurrency - phases.filter(occupiesSlot).length;
  if (free <= 0) return [];
  return phases.flatMap((phase, index) => phase === "queued" ? [index] : []).slice(0, free);
}

export function batchFinished(phases: readonly ShardPhase[]): boolean {
  return phases.every(phase => phase === "remote_ready" || phase === "remote_error" || phase === "collected");
}
