import type { ControlJobRow, StopProcessTreePayload } from "../db/control-jobs-repo.js";
import { ControlJobsRepo } from "../db/control-jobs-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { parseAgentClientPid, parseLictorPid, scanAgentProcesses } from "./reaper.js";
import type { RunningAgentProc } from "./reaper.js";
import { matchesObservedProcessGeneration } from "./session-process-metadata.js";
import { isPidAlive, stopSessionByLictorPid, type StopResult } from "./stop-session.js";

const log = createChildLogger("control-worker");

export interface ControlJobExecutionResult {
  ok: boolean;
  retryable?: boolean;
  result?: unknown;
  error?: string;
}

export type ControlJobExecutor = (job: ControlJobRow) => Promise<ControlJobExecutionResult>;

export interface ControlJobWorkerOptions {
  owner: string;
  pollMs?: number;
  leaseMs?: number;
  now?: () => number;
  executor: ControlJobExecutor;
}

/** Single-concurrency durable queue consumer. Multiple processes remain safe via row leases. */
export class ControlJobWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<boolean> | null = null;
  private stopped = true;

  constructor(
    private readonly repo: ControlJobsRepo,
    private readonly options: ControlJobWorkerOptions,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  async runOnce(): Promise<boolean> {
    if (this.active) return this.active;
    const run = this.processOne();
    this.active = run;
    try {
      return await run;
    } finally {
      this.active = null;
    }
  }

  private async processOne(): Promise<boolean> {
    const now = this.options.now?.() ?? Date.now();
    // taskkill timeout (30s) より長くし、正常な timeout 処理中に別 worker が再取得しない。
    const job = this.repo.claimNext(this.options.owner, this.options.leaseMs ?? 60_000, now);
    if (!job) return false;
    if (job.expires_at <= now) {
      this.repo.markFailed(job.id, this.options.owner, "job expired before execution", { retryable: false }, now);
      return true;
    }
    try {
      const result = await this.options.executor(job);
      const finishedAt = this.options.now?.() ?? Date.now();
      if (result.ok) {
        this.repo.markSucceeded(job.id, this.options.owner, result.result ?? { ok: true }, finishedAt);
      } else {
        this.repo.markFailed(
          job.id,
          this.options.owner,
          result.error ?? "control job failed",
          { retryable: result.retryable ?? true, retryDelayMs: Math.min(30_000, job.attempts * 1_000) },
          finishedAt,
        );
      }
    } catch (error) {
      const finishedAt = this.options.now?.() ?? Date.now();
      this.repo.markFailed(
        job.id,
        this.options.owner,
        error instanceof Error ? error.message : String(error),
        { retryable: true, retryDelayMs: Math.min(30_000, job.attempts * 1_000) },
        finishedAt,
      );
    }
    return true;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => log.error({ err: error }, "control job polling failed"))
        .finally(() => this.schedule(this.options.pollMs ?? 500));
    }, delayMs);
  }
}

export function makeControlJobExecutor(deps: {
  sessions: SessionsRepo;
  stopProcess?: (pid: number) => StopResult | Promise<StopResult>;
  isProcessAlive?: (pid: number) => boolean;
  scanProcesses?: () => Promise<RunningAgentProc[]>;
  nowSec?: () => number;
}): ControlJobExecutor {
  return async (job) => {
    if (job.kind !== "stop_process_tree") {
      return { ok: false, retryable: false, error: `unsupported control job kind: ${job.kind}` };
    }
    let payload: StopProcessTreePayload;
    try {
      payload = JSON.parse(job.payload_json) as StopProcessTreePayload;
    } catch {
      return { ok: false, retryable: false, error: "invalid stop_process_tree payload JSON" };
    }
    const validation = await validateStopTarget(
      deps.sessions,
      payload,
      deps.scanProcesses ?? scanAgentProcesses,
      (deps.nowSec ?? (() => Date.now() / 1000))(),
    );
    if (!validation.ok) return validation;
    if (validation.result !== undefined) return validation;
    if (!(deps.isProcessAlive ?? isPidAlive)(payload.pid)) {
      return { ok: true, result: { already_stopped: true, pid: payload.pid } };
    }
    const result = await (deps.stopProcess ?? stopSessionByLictorPid)(payload.pid);
    if (!result.ok) return { ok: false, retryable: true, error: result.error };
    return { ok: true, result: { pid: payload.pid, method: result.method } };
  };
}

async function validateStopTarget(
  sessions: SessionsRepo,
  payload: StopProcessTreePayload,
  scanProcesses: () => Promise<RunningAgentProc[]>,
  nowSec: number,
): Promise<ControlJobExecutionResult> {
  if (!Number.isInteger(payload.pid) || payload.pid <= 0) {
    return { ok: false, retryable: false, error: `invalid pid: ${payload.pid}` };
  }
  if (payload.role === "orphan") {
    if (!payload.expectedCommand) {
      return { ok: false, retryable: false, error: "orphan job has no command fingerprint" };
    }
    const current = (await scanProcesses()).find((proc) => proc.pid === payload.pid);
    if (!current) {
      return isPidAlive(payload.pid)
        ? { ok: false, retryable: true, error: "orphan PID is alive but its command could not be verified" }
        : { ok: true, result: { already_stopped: true, pid: payload.pid } };
    }
    if (current.cmd !== payload.expectedCommand) {
      return { ok: false, retryable: false, error: "PID command changed; refusing to stop reused PID" };
    }
    return { ok: true };
  }
  if (!payload.sessionId) {
    return { ok: false, retryable: false, error: "session stop job has no session id" };
  }
  const session = sessions.findSession(payload.sessionId);
  if (!session) {
    return { ok: false, retryable: false, error: "session disappeared; refusing to stop unverified PID" };
  }
  const expectedPid = payload.role === "lictor"
    ? parseLictorPid(session.metadata)
    : parseAgentClientPid(session.metadata);
  if (expectedPid !== payload.pid) {
    return { ok: false, retryable: false, error: "session PID metadata changed; refusing to stop reused PID" };
  }
  const current = (await scanProcesses()).find((proc) => proc.pid === payload.pid);
  if (!current || !matchesObservedProcessGeneration(session.metadata, current.ageSec, nowSec)) {
    return { ok: false, retryable: false, error: "process generation changed; refusing to stop reused PID" };
  }
  return { ok: true };
}
