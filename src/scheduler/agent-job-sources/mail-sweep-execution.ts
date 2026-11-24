import type { MailSweepData } from "../agent-jobs/quaestor-mail-sweep-data.js";

// Greater than the total budget of endpoint resolution, sweep and document lookup.
const RESERVATION_MS = 120_000;

export interface MailSweepStore {
  reserve(key: string, startedAt: number): boolean;
  read(key: string): { startedAt: number; result: MailSweepData | null } | null;
  finish(key: string, result: MailSweepData): boolean;
}

/** A durable reservation authorizes one POST per firing key. */
export function createMailSweepExecution(store: MailSweepStore, sweep: () => Promise<MailSweepData>, now = Date.now) {
  return async (key: string): Promise<MailSweepData | null> => {
    const startedAt = now();
    if (store.reserve(key, startedAt)) {
      const result = await sweep();
      return store.finish(key, result) ? result : store.read(key)?.result ?? null;
    }
    const previous = store.read(key);
    if (!previous || previous.result || startedAt - previous.startedAt < RESERVATION_MS) {
      return previous?.result ?? null;
    }
    const unknown: MailSweepData = { sweep_status: "unknown", failure_kind: "interrupted" };
    return store.finish(key, unknown) ? unknown : store.read(key)?.result ?? null;
  };
}
