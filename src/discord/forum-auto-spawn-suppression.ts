const EXPLICIT_SPAWN_GRACE_MS = 5_000;
const THREAD_CREATE_GRACE_MS = 1_000;

/** Arbitrates the race between a Forum ThreadCreate event and explicit `/spawn`. */
export class ForumAutoSpawnSuppression {
  private readonly untilByThread = new Map<string, number>();

  suppressForExplicitSpawn(threadId: string, now = Date.now()): void {
    if (!threadId.trim()) return;
    this.untilByThread.set(threadId, now + EXPLICIT_SPAWN_GRACE_MS);
  }

  isSuppressed(threadId: string, now = Date.now()): boolean {
    const until = this.untilByThread.get(threadId);
    if (until === undefined) return false;
    if (until > now) return true;
    this.untilByThread.delete(threadId);
    return false;
  }
}

export const forumAutoSpawnSuppression = new ForumAutoSpawnSuppression();

/** Wait briefly so a concurrent slash-command interaction can win this race. */
export async function waitForExplicitForumSpawn(
  suppression: ForumAutoSpawnSuppression,
  threadId: string,
  delayMs = THREAD_CREATE_GRACE_MS,
): Promise<boolean> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  return suppression.isSuppressed(threadId);
}
