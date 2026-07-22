import { randomUUID } from "node:crypto";

export interface WorkerLeaseRepo {
  get(key: string): string | null;
  compareAndSwap(key: string, expected: string | null, value: string | null): boolean;
}

export interface WorkerLease {
  kind: "worker";
  role: string;
  owner: string;
  pid: number;
  ts: number;
  expires_at: number;
  fencing_token: number;
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
  },
): WorkerLease | null {
  const raw = repo.get(opts.key);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<WorkerLease>;
    const roleOk = o.role === opts.role;
    const now = opts.now ?? Date.now();
    const ttlMs = opts.ttlMs ?? WORKER_LEASE_TTL_MS;
    if (
      o.kind === "worker" &&
      roleOk &&
      typeof o.owner === "string" && o.owner.length > 0 &&
      typeof o.pid === "number" &&
      typeof o.ts === "number" &&
      typeof o.expires_at === "number" &&
      typeof o.fencing_token === "number" && Number.isInteger(o.fencing_token) && o.fencing_token > 0 &&
      o.expires_at > now && now - o.ts < ttlMs
    ) {
      return {
        kind: "worker", role: opts.role, owner: o.owner, pid: o.pid, ts: o.ts,
        expires_at: o.expires_at, fencing_token: o.fencing_token,
      };
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
    ttlMs?: number;
    owner?: string;
  },
): { lease: WorkerLease; owns(): boolean; stop(): void } {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? WORKER_LEASE_TTL_MS;
  const owner = opts.owner ?? randomUUID();
  const priorRaw = repo.get(opts.key);
  const priorToken = parseFencingToken(priorRaw);
  const acquiredAt = now();
  let lease: WorkerLease = {
    kind: "worker",
    role: opts.role,
    owner,
    pid,
    ts: acquiredAt,
    expires_at: acquiredAt + ttlMs,
    fencing_token: priorToken + 1,
  };
  const active = readWorkerLease(repo, { key: opts.key, role: opts.role, now: acquiredAt, ttlMs });
  if (active || !repo.compareAndSwap(opts.key, priorRaw, JSON.stringify(lease))) {
    throw new Error(`worker lease already owned: ${opts.key}`);
  }
  let currentRaw = JSON.stringify(lease);
  let owned = true;
  const beat = () => {
    if (!owned) return;
    try {
      const ts = now();
      const next = { ...lease, ts, expires_at: ts + ttlMs } satisfies WorkerLease;
      const nextRaw = JSON.stringify(next);
      if (!repo.compareAndSwap(opts.key, currentRaw, nextRaw)) {
        owned = false;
        return;
      }
      lease = next;
      currentRaw = nextRaw;
    } catch {
      // Keep running; a later heartbeat may succeed.
    }
  };
  const timer = setInterval(beat, opts.heartbeatMs ?? WORKER_HEARTBEAT_MS);
  timer.unref?.();
  return {
    get lease() { return lease; },
    owns: () => owned,
    stop() {
      clearInterval(timer);
      if (!owned) return;
      try {
        repo.compareAndSwap(opts.key, currentRaw, null);
        owned = false;
      } catch {
        // Best effort; the TTL will expire stale leases.
      }
    },
  };
}

function parseFencingToken(raw: string | null): number {
  if (!raw) return 0;
  try {
    const value = (JSON.parse(raw) as { fencing_token?: unknown }).fencing_token;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
