import { planCloudBatch, type CloudBatchDefinition, type PlannedShard } from "./batch-plan.js";
import { batchFinished, remoteIdOf, selectShardsToKick, shardPhase,
  type AttemptJournal, type RemoteTaskStatus, type ShardPhase } from "./batch-policy.js";
import type { FileCloudBatchStore, StoredCloudBatch } from "./batch-store.js";
import type { CloudEnvironment } from "./runtime-config.js";
import type { CloudScope, CloudWorkInput } from "./runtime-service.js";
import { publicCloudError } from "./public-error.js";

export interface CloudBatchPorts {
  store: FileCloudBatchStore;
  targets(scope: CloudScope): Promise<CloudEnvironment[]>;
  authorizeTask(reference: string, scope: CloudScope): Promise<void>;
  /** Budget/capacity/human-question gates for an unattended kick by the batch's creator. */
  authorizeKick(batch: StoredCloudBatch): Promise<void>;
  submit(scope: CloudScope, input: CloudWorkInput): Promise<unknown>;
  journal(scope: CloudScope, attemptId: string): Promise<AttemptJournal>;
  observe(target: CloudEnvironment, wanted: ReadonlySet<string>): Promise<Map<string, RemoteTaskStatus>>;
  now(): number;
}

export interface CloudBatchStatus {
  batchId: string; taskReference: string; targetId: string; concurrency: number; createdAt: number;
  stopped: boolean; finished: boolean; observation: "observed" | "not_needed" | "failed";
  counts: Record<ShardPhase, number>;
  shards: Array<{ index: number; attemptId: string; phase: ShardPhase; remoteId: string | null }>;
  lastKickAt: number | null; lastError: string | null;
}

const keyOf = (scope: CloudScope, batchId: string): string => JSON.stringify([scope.repositoryKey, scope.subsidiaryId, batchId]);

/** Application use case: fans a batch out over the existing single-attempt submission. */
export class CloudBatchKicker {
  private readonly running = new Map<string, Promise<CloudBatchStatus>>();
  private readonly notes = new Map<string, { lastKickAt: number | null; lastError: string | null }>();
  private readonly observations = new Map<string, Map<string, RemoteTaskStatus>>();
  private sweeping: Promise<void> | null = null;

  constructor(private readonly ports: CloudBatchPorts) {}

  private async codexTarget(scope: CloudScope, targetId: string): Promise<CloudEnvironment> {
    const target = (await this.ports.targets(scope)).find(t => t.id === targetId);
    if (!target) throw new Error("cloud_target_not_found");
    if (target.provider !== "codex-cloud") throw new Error("cloud_batch_provider_unsupported");
    return target;
  }

  async create(scope: CloudScope, sessionId: string, definition: CloudBatchDefinition): Promise<CloudBatchStatus> {
    planCloudBatch(definition);
    await this.codexTarget(scope, definition.targetId);
    await this.ports.authorizeTask(definition.taskReference, scope);
    const batch = await this.ports.store.create(scope, sessionId, definition, this.ports.now());
    // HTTP creation is durable admission only. Provider I/O belongs to the managed
    // background sweep (or startTick), so accepting a batch never waits on a CLI.
    return this.evaluate(batch, false);
  }

  /** Starts a managed tick without making an HTTP request wait for provider I/O. */
  startTick(scope: CloudScope, batchId: string): void {
    // The caller has already received 202; status exposes safe retryable failures.
    void this.tick(scope, batchId).catch(() => undefined);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...(this.sweeping ? [this.sweeping] : []), ...this.running.values()]);
  }

  async stop(scope: CloudScope, batchId: string): Promise<CloudBatchStatus> {
    const batch = await this.batch(scope, batchId);
    await this.ports.store.stop(scope, batchId, this.ports.now());
    return this.evaluate(batch, false);
  }

  async status(scope: CloudScope, batchId: string): Promise<CloudBatchStatus> {
    return this.evaluate(await this.batch(scope, batchId), false);
  }

  async list(scope: CloudScope, limit = 20): Promise<CloudBatchStatus[]> {
    const result: CloudBatchStatus[] = [];
    for (const batch of (await this.ports.store.list(scope)).slice(0, Math.max(1, Math.min(50, limit)))) {
      try {
        await this.ports.authorizeTask(batch.definition.taskReference, scope);
        result.push(await this.evaluate(batch, false));
      } catch { /* Do not disclose batches whose linked task is no longer authorized in this scope. */ }
    }
    return result;
  }

  /** Serialized per batch in this process; cross-process duplicates are blocked by the intent journal. */
  async tick(scope: CloudScope, batchId: string): Promise<CloudBatchStatus> {
    const key = keyOf(scope, batchId), pending = this.running.get(key);
    if (pending) return pending;
    const run = this.batch(scope, batchId).then(batch => this.evaluate(batch, true));
    this.running.set(key, run);
    try { return await run; }
    finally { this.running.delete(key); }
  }

  /** Background sweep. Overlapping timer firings join the sweep in progress. */
  async tickAll(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      for (const batch of await this.ports.store.listAll()) {
        if (await this.ports.store.stopped(batch.scope, batch.definition.batchId)) continue;
        // One corrupt or temporarily unauthorized batch must not starve other scopes.
        await this.tick(batch.scope, batch.definition.batchId).catch(() => undefined);
      }
    })();
    try { await this.sweeping; }
    finally { this.sweeping = null; }
  }

  private async batch(scope: CloudScope, batchId: string): Promise<StoredCloudBatch> {
    const batch = await this.ports.store.read(scope, batchId);
    if (!batch) throw new Error("cloud_batch_not_found");
    await this.ports.authorizeTask(batch.definition.taskReference, scope);
    return batch;
  }

  private async evaluate(batch: StoredCloudBatch, kick: boolean): Promise<CloudBatchStatus> {
    const { scope, definition } = batch, key = keyOf(scope, definition.batchId);
    const shards = planCloudBatch(definition);
    const stopped = await this.ports.store.stopped(scope, definition.batchId);
    const journals = await Promise.all(shards.map(s => this.ports.journal(scope, s.attemptId)));
    const target = kick ? await this.codexTarget(scope, definition.targetId) : null;
    const wanted = new Set(journals.filter(j => !j.verified).map(remoteIdOf).filter((id): id is string => !!id));
    const observed = new Map(this.observations.get(key) ?? []);
    let observation: CloudBatchStatus["observation"] = observed.size ? "observed" : "not_needed";
    if (target && wanted.size) {
      try {
        for (const [remoteId, status] of await this.ports.observe(target, wanted)) observed.set(remoteId, status);
        this.observations.set(key, observed);
        observation = "observed";
      }
      catch { observation = "failed"; }
    }
    const phases = journals.map(j => shardPhase(j, observed));
    const note = this.notes.get(key) ?? { lastKickAt: null, lastError: null };
    if (kick) {
      const indices = selectShardsToKick(phases, definition.concurrency, stopped);
      if (indices.length) await this.kick(batch, shards, indices, journals, phases, note);
      this.notes.set(key, note);
    }
    const counts = { queued: 0, unknown: 0, running: 0, remote_ready: 0, remote_error: 0, collected: 0 };
    for (const phase of phases) counts[phase]++;
    return { batchId: definition.batchId, taskReference: definition.taskReference, targetId: definition.targetId,
      concurrency: definition.concurrency, createdAt: batch.createdAt, stopped, finished: batchFinished(phases), observation, counts,
      shards: shards.map((s, i) => ({ index: s.index, attemptId: s.attemptId, phase: phases[i]!, remoteId: remoteIdOf(journals[i]!) })),
      lastKickAt: note.lastKickAt, lastError: note.lastError };
  }

  private async kick(batch: StoredCloudBatch, shards: PlannedShard[], indices: number[], journals: AttemptJournal[], phases: ShardPhase[],
    note: { lastKickAt: number | null; lastError: string | null }): Promise<void> {
    const { scope, definition } = batch;
    try { await this.ports.authorizeKick(batch); }
    catch (error) { note.lastError = publicCloudError(error); return; }
    note.lastError = null;
    for (const index of indices) {
      // A stop may arrive while a prior shard is being submitted. Re-check before
      // every subsequent external launch; already-started work is never cancelled.
      if (await this.ports.store.stopped(scope, definition.batchId)) return;
      const shard = shards[index]!;
      try {
        await this.ports.submit(scope, { attemptId: shard.attemptId, targetId: definition.targetId,
          taskReference: definition.taskReference, instruction: shard.instruction, computeReason: definition.computeReason,
          llmReason: definition.llmReason, gpuRequired: definition.gpuRequired, work: definition.work });
        note.lastKickAt = this.ports.now();
        // Accepted or ambiguous, the shard now holds a slot until observed finished.
        const journal = await this.ports.journal(scope, shard.attemptId);
        journals[index] = journal;
        phases[index] = journal.intent ? (remoteIdOf(journal) ? "running" : "unknown") : "queued";
      } catch (error) {
        // Preflight/target failures repeat for every shard; stop this round and retry next tick.
        note.lastError = publicCloudError(error);
        const journal = await this.ports.journal(scope, shard.attemptId).catch(() => null);
        if (journal?.intent) phases[index] = "unknown";
        return;
      }
    }
  }
}
