import { lstat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { AgyGeneration } from "./agy-usage-metadata.js";

const MAX_CACHED_DATABASES = 128;
const CACHE_TTL_MS = 10 * 60 * 1000;
const FAILED_SNAPSHOT_TTL_MS = 5_000;
const SNAPSHOT_TIMEOUT_MS = 8_000;
const MAX_PENDING_SNAPSHOTS = 16;

export interface AgyUsageSnapshot {
  lastIndex: number | null;
  rows: ReadonlyArray<AgyGeneration & { index: number }>;
}

async function snapshotKey(path: string): Promise<{ key: string; modifiedAt: number } | null> {
  try {
    const main = await lstat(path, { bigint: true });
    if (!main.isFile()) return null;
    const wal = await lstat(path + "-wal", { bigint: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (wal && !wal.isFile()) return null;
    return {
      key: [main.ino, main.mtimeNs, main.size, wal?.ino, wal?.mtimeNs, wal?.size].join(":"),
      modifiedAt: Number((wal && wal.mtimeNs > main.mtimeNs ? wal.mtimeNs : main.mtimeNs) / 1_000_000n),
    };
  } catch {
    return null;
  }
}

function readSnapshot(path: string): Promise<AgyUsageSnapshot | null> {
  const source = import.meta.url.endsWith(".ts");
  const entry = source ? "./agy-usage-sqlite-worker.ts" : "./agy-usage-sqlite-worker.js";
  const worker = new Worker(new URL(entry, import.meta.url), {
    workerData: { path },
    ...(source ? { execArgv: ["--import", "tsx"] } : {}),
  });
  return new Promise((resolve) => {
    const finish = (snapshot: AgyUsageSnapshot | null) => {
      clearTimeout(timer);
      resolve(snapshot);
    };
    const timer = setTimeout(() => {
      void worker.terminate().catch(() => { /* The worker may already have exited. */ });
      finish(null);
    }, SNAPSHOT_TIMEOUT_MS);
    worker.once("message", finish);
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

type CacheEntry = { key: string; readAt: number; snapshot: AgyUsageSnapshot | null };

/** Shared across cost readers in the process. Only one SQLite scan runs at a time. */
export class AgyUsageDatabase {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AgyUsageSnapshot | null>>();
  private queue: Promise<unknown> = Promise.resolve();

  async read(path: string, modifiedSince = -Infinity): Promise<AgyUsageSnapshot | null> {
    const identity = await snapshotKey(path);
    if (!identity || identity.modifiedAt < modifiedSince) return null;
    const prior = this.inFlight.get(path);
    if (prior) return prior;
    if (this.inFlight.size >= MAX_PENDING_SNAPSHOTS) return null;
    const work = this.queue.then(() => this.readCached(path)).catch(() => null);
    this.queue = work;
    this.inFlight.set(path, work);
    void work.then(() => this.inFlight.delete(path));
    return work;
  }

  private async readCached(path: string): Promise<AgyUsageSnapshot | null> {
    const identity = await snapshotKey(path);
    if (!identity) return null;
    const { key } = identity;
    const cached = this.cache.get(path);
    const ttl = cached?.snapshot ? CACHE_TTL_MS : FAILED_SNAPSHOT_TTL_MS;
    if (cached?.key === key && Date.now() - cached.readAt < ttl) return cached.snapshot;
    const snapshot = await readSnapshot(path);
    if (key === (await snapshotKey(path))?.key) {
      this.cache.delete(path);
      this.cache.set(path, { key, readAt: Date.now(), snapshot });
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined && this.cache.size > MAX_CACHED_DATABASES) this.cache.delete(oldest);
    }
    return snapshot;
  }
}

export const agyUsageDatabase = new AgyUsageDatabase();
