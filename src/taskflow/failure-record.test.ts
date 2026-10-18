import { describe, expect, it } from 'vitest';
import { describeTaskflowFailure } from './failure.js';
import { recordTaskflowFailure } from './failure-record.js';

describe('persisted taskflow failure evidence', () => {
  it('keeps only safe fields in an event and the latest snapshot', () => {
      const captured: unknown[] = [];
      recordTaskflowFailure({
        appendEvent: (event) => { captured.push(event); },
        mergeMetadata: (id, patch) => { captured.push({ id, patch }); },
      }, 'session-test', 'revisor-notice', describeTaskflowFailure(new Error('token=private-value')), 123);
      expect(captured[0]).toEqual({ session_id: 'session-test', ts: 123, kind: 'taskflow.failure', payload: {
        version: 1, operation: 'revisor-notice', reason: 'taskflow_internal_error', status: 500, observed_at: 123,
      } });
      expect(captured[1]).toMatchObject({ id: 'session-test', patch: { taskflow_last_failure: { observed_at: 123 } } });
      expect(JSON.stringify(captured)).not.toContain('private-value');
  });
});
