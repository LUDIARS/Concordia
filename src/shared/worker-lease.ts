export interface WorkerLeaseRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface WorkerLease {
  kind: "worker";
  role: string;
  pid: number;
  ts: number;
}

export const WORKER_LEASE_TTL_MS = 90_000;
export const WORKER_HEARTBEAT_MS = 30_000;
export const WORKER_LEASE_CHECK_MS = 15_000;

export function readWorkerLease(
  repo: WorkerLeaseRepo,
  opts: {
    key: string;
    role: string;
    now?: number;
    ttlMs?: number;
    allowLegacyRole?: boolean;
  },
): WorkerLease | null {
  const raw = repo.get(opts.key);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<WorkerLease>;
    const roleOk = o.role === opts.role || (opts.allowLegacyRole === true && o.role === undefined);
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? WORKER_LEASE_TTL_MS;
    if (
      o.kind === "worker" &&
      roleOk &&
      typeof o.pid === "number" &&
      typeof o.ts === "number" &&
      now - o.ts < ttlMs
    ) {
      return { kind: "worker", role: opts.role, pid: o.pid, ts: o.ts };
    }
  } catch {
    // Broken leases are ignored; the next heartbeat will replace them.
  }
  return null;
}

export function startWorkerLease(
  repo: WorkerLeaseRepo,
  opts: {
    key: string;
    role: string;
    pid?: number;
    now?: () => number;
    heartbeatMs?: number;
  },
): { stop(): void } {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const beat = () => {
    try {
      repo.set(opts.key, JSON.stringify({ kind: "worker", role: opts.role, pid, ts: now() } satisfies WorkerLease));
    } catch {
      // Keep running; a later heartbeat may succeed.
    }
  };
  beat();
  const timer = setInterval(beat, opts.heartbeatMs ?? WORKER_HEARTBEAT_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      try {
        repo.delete(opts.key);
      } catch {
        // Best effort; the TTL will expire stale leases.
      }
    },
  };
}
