import type Database from "better-sqlite3";
import { reconcilePendingQuestionLifecycle } from "../db/pending-question-lifecycle.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

/** One owner for event subscription and deadline timer; restart reconciles existing rows. */
export function startQuestionLifecycleWatch(db: Database.Database): { stop(): void } {
  const log = createChildLogger("question-lifecycle");
  const scan = (): void => {
    try {
      reconcilePendingQuestionLifecycle(db, Math.floor(Date.now() / 1000));
    } catch (error) {
      log.error({ error }, "pending question lifecycle reconciliation failed");
    }
  };
  scan();
  const unsubscribe = eventBus.subscribe(event => {
    if (["session.ended", "session.lost", "session.started", "question.posted"].includes(event.type)) scan();
  });
  const timer = setInterval(scan, 30_000);
  timer.unref();
  return { stop: () => { clearInterval(timer); unsubscribe(); } };
}
