export function createTestForumRefreshTrigger(input: {
  reconcile: (reason: string) => Promise<void>;
  warn: (message: string) => void;
}): (reason: string) => Promise<void> {
  let running: Promise<void> | null = null;
  let queuedReason: string | null = null;
  return (reason) => {
    if (running) {
      queuedReason = reason;
      return running;
    }
    const pending = (async () => {
      let nextReason: string | null = reason;
      while (nextReason) {
        const currentReason = nextReason;
        queuedReason = null;
        await input.reconcile(currentReason).catch((error) => {
          input.warn(`test-forum ${currentReason} reconcile failed: ${(error as Error).message}`);
        });
        nextReason = queuedReason;
      }
    })()
      .finally(() => {
        if (running === pending) running = null;
      });
    running = pending;
    return pending;
  };
}
