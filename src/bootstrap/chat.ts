import type { DiscordConfigRepo } from "../db/discord-repo.js";
import {
  readWorkerLease,
  startWorkerLease,
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_CHECK_MS,
  WORKER_LEASE_TTL_MS,
  type WorkerLease,
} from "../shared/worker-lease.js";

export type ChatMode = "embedded" | "worker" | "off";

const CHAT_WORKER_LEASE_KEY = "chat_worker_lease";
const CHAT_WORKER_ROLE = "chat-relay";

export const CHAT_WORKER_CHECK_MS = WORKER_LEASE_CHECK_MS;

export function readChatMode(env: NodeJS.ProcessEnv = process.env): ChatMode {
  const raw = (env.CONCORDIA_CHAT_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "worker") return raw;
  return "embedded";
}

export function chatEmbeddedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readChatMode(env) === "embedded";
}

export function readChatWorkerLease(
  repo: DiscordConfigRepo,
  now: number = Date.now(),
): WorkerLease | null {
  return readWorkerLease(repo, {
    key: CHAT_WORKER_LEASE_KEY,
    role: CHAT_WORKER_ROLE,
    now,
    ttlMs: WORKER_LEASE_TTL_MS,
  });
}

export function startChatWorkerLease(
  repo: DiscordConfigRepo,
  opts: { pid?: number; now?: () => number } = {},
): { stop(): void } {
  return startWorkerLease(repo, {
    key: CHAT_WORKER_LEASE_KEY,
    role: CHAT_WORKER_ROLE,
    pid: opts.pid,
    now: opts.now,
    heartbeatMs: WORKER_HEARTBEAT_MS,
  });
}
