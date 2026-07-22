import type { DiscordConfigRepo } from "../db/discord-repo.js";
import {
  readWorkerLease,
  startWorkerLease,
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_CHECK_MS,
  WORKER_LEASE_TTL_MS,
  type WorkerLease,
} from "../shared/worker-lease.js";

export type WorkflowMode = "embedded" | "worker";

const WORKFLOW_WORKER_LEASE_KEY = "workflow_worker_lease";
const WORKFLOW_WORKER_ROLE = "delegation-workflow";

export const WORKFLOW_WORKER_CHECK_MS = WORKER_LEASE_CHECK_MS;

export function readWorkflowMode(env: NodeJS.ProcessEnv = process.env): WorkflowMode {
  return (env.CONCORDIA_WORKFLOW_MODE ?? "").trim().toLowerCase() === "worker"
    ? "worker"
    : "embedded";
}

export function workflowEmbeddedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readWorkflowMode(env) === "embedded";
}

export function readWorkflowWorkerLease(
  repo: DiscordConfigRepo,
  now: number = Date.now(),
): WorkerLease | null {
  return readWorkerLease(repo, {
    key: WORKFLOW_WORKER_LEASE_KEY,
    role: WORKFLOW_WORKER_ROLE,
    now,
    ttlMs: WORKER_LEASE_TTL_MS,
  });
}

export function startWorkflowWorkerLease(
  repo: DiscordConfigRepo,
  opts: { pid?: number; now?: () => number } = {},
): ReturnType<typeof startWorkerLease> {
  return startWorkerLease(repo, {
    key: WORKFLOW_WORKER_LEASE_KEY,
    role: WORKFLOW_WORKER_ROLE,
    pid: opts.pid,
    now: opts.now,
    heartbeatMs: WORKER_HEARTBEAT_MS,
  });
}
