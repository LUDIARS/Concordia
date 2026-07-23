export interface BootForumReconcileLog {
  info(message: string): void;
  warn(message: string): void;
}

export async function runBootForumReconciliations(input: {
  reconcileSessionForum: () => Promise<void>;
  reconcileTestForum: () => Promise<void>;
  log: BootForumReconcileLog;
}): Promise<void> {
  const [session, test] = await Promise.allSettled([
    input.reconcileSessionForum(),
    input.reconcileTestForum(),
  ]);
  if (session.status === "fulfilled") {
    input.log.info("session-forum boot reconcile completed");
  } else {
    input.log.warn(`session-forum boot reconcile failed: ${String(session.reason instanceof Error ? session.reason.message : session.reason)}`);
  }
  if (test.status === "fulfilled") {
    input.log.info("test-forum boot reconcile completed");
  } else {
    input.log.warn(`test-forum boot reconcile failed: ${String(test.reason instanceof Error ? test.reason.message : test.reason)}`);
  }
}

export function scheduleBootForumReconciliations(input: {
  delayMs: number;
  schedule: (label: string, fn: () => Promise<void>, delayMs: number) => void;
  reconcileSessionForum: () => Promise<void>;
  reconcileTestForum: () => Promise<void>;
  log: BootForumReconcileLog;
}): void {
  input.schedule(
    "forum boot reconcile",
    () => runBootForumReconciliations(input),
    Math.max(0, input.delayMs),
  );
}
