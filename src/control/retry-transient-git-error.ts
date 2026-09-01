/** @implements spec/tasks/2026-09-01-spawn-target-worktree-retry.md — 一過性 worktree Git 失敗の限定再試行 */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAYS_MS = [300, 900];

export interface RetryTransientGitOptions {
  attempts?: number;
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** @implements SPEC-SPAWN-TARGET-WORKTREE-RETRY */
export function isTransientGitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ["EPERM", "EBUSY", "Permission denied", "resource busy"].some((fragment) => message.includes(fragment));
}

/** @implements SPEC-SPAWN-TARGET-WORKTREE-RETRY */
export async function retryTransientGit<T>(
  fn: () => Promise<T>,
  options: RetryTransientGitOptions = {},
): Promise<T> {
  const requestedAttempts = Math.floor(options.attempts ?? DEFAULT_ATTEMPTS);
  const attempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, requestedAttempts)
    : DEFAULT_ATTEMPTS;
  const delaysMs = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransientGitError(error) || attempt === attempts - 1) throw error;
      const delayMs = delaysMs[attempt] ?? 0;
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw new Error("retryTransientGit exhausted without an attempt");
}
