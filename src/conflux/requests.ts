import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { BuildInput, SpawnInput } from "./models.js";
import { buildIdentity, receiptMatch } from "./policy.js";
import type { ConfluxRepository } from "./repository.js";
import type { SessionReceipt } from "./models.js";

export type ConfluxError = { status: 400 | 403 | 404 | 409 | 503; error: string };
type SpawnOutcome = SessionReceipt | ConfluxError;

function fingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const pending = { status: 503, error: "spawn_result_unavailable" } as const;

export class ConfluxRequests {
  constructor(private readonly repo: Pick<ConfluxRepository, "spawn" | "reserveSpawn" | "finishLaunch" | "reconcileSpawn" | "queueBuild">, private readonly deps: {
    canSpawn: (input: SpawnInput) => ConfluxError | null;
    launch: (input: SpawnInput, enrollment: string) => Promise<boolean>;
    canBuild: (project: string) => boolean;
    now?: () => number;
    spawnWaitMs?: number;
  }) {}

  lookup(key: string): SpawnOutcome {
    const entry = this.repo.spawn(key);
    if (!entry) return { status: 404, error: "spawn_not_found" };
    const session = this.repo.reconcileSpawn(entry);
    if (session) return { accepted: true, session_id: session.id, run_id: entry.run_id, status: session.status };
    return entry.state === "failed" ? { status: 409, error: "spawn_failed" } : pending;
  }

  async spawn(input: SpawnInput): Promise<SpawnOutcome> {
    const key = input.idempotency_key;
    const digest = fingerprint(input);
    const match = receiptMatch(this.repo.spawn(key)?.fingerprint, digest);
    if (match === "conflict") return { status: 409, error: "idempotency_conflict" };
    if (match === "same") return this.lookup(key);
    const rejection = this.deps.canSpawn(input);
    if (rejection) return rejection;
    const enrollment = randomUUID();
    if (!this.repo.reserveSpawn(key, digest, randomUUID(), enrollment)) {
      return receiptMatch(this.repo.spawn(key)?.fingerprint, digest) === "same"
        ? this.lookup(key) : { status: 409, error: "idempotency_conflict" };
    }
    try {
      if (!await this.deps.launch(input, enrollment)) {
        this.repo.finishLaunch(key, "failed");
        return this.lookup(key);
      }
    } catch {
      // A thrown launcher error does not prove the process was never started.
      this.repo.finishLaunch(key, "uncertain");
      return this.lookup(key);
    }
    const until = Date.now() + (this.deps.spawnWaitMs ?? 5_000);
    let result = this.lookup(key);
    while (result === pending && Date.now() < until) {
      await delay(100);
      result = this.lookup(key);
    }
    return result;
  }

  build(input: BuildInput): { accepted: true } | ConfluxError {
    const identity = buildIdentity(input.dedupe_key, input.commit);
    const branch = `evolution/${input.tide}/${input.variant}`;
    if (!identity || (input.branch && input.branch !== branch && input.branch !== `${branch}/main`)) {
      return { status: 400, error: "invalid_build_target" };
    }
    if (!this.deps.canBuild(input.project_code)) return { status: 403, error: "build_not_enabled" };
    const digest = fingerprint({ ...input, platforms: [...new Set(input.platforms)].sort() });
    const stored = this.repo.queueBuild({ ...input, ...identity }, digest, (this.deps.now ?? Date.now)());
    return receiptMatch(stored, digest) === "same" ? { accepted: true } : { status: 409, error: "dedupe_conflict" };
  }
}
