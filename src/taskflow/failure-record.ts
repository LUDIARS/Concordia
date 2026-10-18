import type { SessionsRepo } from '../db/sessions-repo.js';
import type { TaskflowFailureDescription } from './failure.js';

export type TaskflowFailureOperation = 'interactive-completion' | 'revisor-notice' | 'session-assignment';

/** Persist safe evidence independently of notification delivery. @implements CC-TF-ERROR-01 */
export function recordTaskflowFailure(
  sessions: Pick<SessionsRepo, 'appendEvent' | 'mergeMetadata'>,
  sessionId: string,
  operation: TaskflowFailureOperation,
  failure: TaskflowFailureDescription,
  observedAt: number,
): void {
  const payload = { version: 1, operation, reason: failure.code, status: failure.status, observed_at: observedAt };
  sessions.appendEvent({ session_id: sessionId, ts: observedAt, kind: 'taskflow.failure', payload });
  sessions.mergeMetadata(sessionId, { taskflow_last_failure: payload });
}
