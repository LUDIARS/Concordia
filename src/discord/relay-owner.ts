import type { DiscordConfigRepo } from "../db/discord-repo.js";
import {
  readWorkerLease as readSharedWorkerLease,
  startWorkerLease as startSharedWorkerLease,
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_CHECK_MS,
  WORKER_LEASE_TTL_MS,
  type WorkerLease,
} from "../shared/worker-lease.js";

const KEY = "chat_worker_lease";
const ROLE = "chat-relay";
const LEGACY_KEY = "relay_owner_lease";
const LEGACY_ROLE = "discord-relay";

export const RELAY_LEASE_TTL_MS = WORKER_LEASE_TTL_MS;
export const RELAY_HEARTBEAT_MS = WORKER_HEARTBEAT_MS;
export const RELAY_CHECK_MS = WORKER_LEASE_CHECK_MS;

export type RelayLease = WorkerLease;

export function readWorkerLease(repo: DiscordConfigRepo, now: number = Date.now()): RelayLease | null {
  return readSharedWorkerLease(repo, {
    key: KEY,
    role: ROLE,
    now,
    ttlMs: RELAY_LEASE_TTL_MS,
  }) ?? readSharedWorkerLease(repo, {
    key: LEGACY_KEY,
    role: LEGACY_ROLE,
    now,
    ttlMs: RELAY_LEASE_TTL_MS,
    allowLegacyRole: true,
  });
}

export function startWorkerLease(
  repo: DiscordConfigRepo,
  opts: { pid?: number; now?: () => number } = {},
): { stop(): void } {
  return startSharedWorkerLease(repo, {
    key: KEY,
    role: ROLE,
    pid: opts.pid,
    now: opts.now,
    heartbeatMs: RELAY_HEARTBEAT_MS,
  });
}
