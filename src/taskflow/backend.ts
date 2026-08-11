import type { CreateTaskInput, MemoriaClient } from "../memoria/client.js";

export interface TaskBackend {
  createTask(input: CreateTaskInput): Promise<{ id: string | number }>;
}

export type TaskCreationOutcome = "not-created" | "unknown";

/**
 * Distinguishes safe retries from failures that may have happened after the POST was accepted.
 * @implements spec/feature/task-workflow.md — 2.2 登録 (reconcile)
 */
export class TaskCreationError extends Error {
  constructor(
    readonly outcome: TaskCreationOutcome,
    cause: unknown,
  ) {
    super(errorMessage(cause), { cause });
    this.name = "TaskCreationError";
  }
}

/** Phase 4 で ActioBackend を追加する。現時点では Memoria のみを実装する。 */
export class MemoriaBackend implements TaskBackend {
  constructor(private readonly client: MemoriaClient) {}
  async createTask(input: CreateTaskInput): Promise<{ id: string | number }> {
    try {
      return await this.client.createTask(input);
    } catch (error) {
      throw new TaskCreationError(isPreRequestConnectionFailure(error) ? "not-created" : "unknown", error);
    }
  }
}

/** Connection setup failures happen before an HTTP request can reach Memoria, so retrying is safe. */
function isPreRequestConnectionFailure(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ECONNREFUSED"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "UND_ERR_CONNECT_TIMEOUT";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (typeof value.code === "string") return value.code;
  return value.cause === error ? null : errorCode(value.cause);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
