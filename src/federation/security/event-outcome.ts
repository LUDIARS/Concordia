import type { SiteEventPayload } from '../remote-session-payload.js';

/**
 * 拠点が受信イベントごとに決める配送結果 (spec/feature/cc-workload-security.md「配送結果の区別」)。
 * ack は accepted/duplicate だけに使い、拒否や一時障害で依頼を outbox から消さない。
 */
export const EVENT_REJECT_REASONS = [
  'invalid_envelope',
  'unconfigured',
  'grant_mismatch',
  'inactive_token',
  'proof_invalid',
  'replay',
  'ledger_full',
  'handler_failed',
] as const;
export type EventRejectReason = (typeof EVENT_REJECT_REASONS)[number];

export type EventRetryReason = 'authority_unavailable' | 'stale_proof' | 'not_current' | 'storage_failed';

export type EventAuthorization =
  | { status: 'accepted'; payload: SiteEventPayload }
  | { status: 'duplicate' }
  | { status: 'retry'; reason: EventRetryReason }
  | { status: 'rejected'; reason: EventRejectReason };

/** handler まで終えた後に拠点が本社へ返す応答。 */
export type EventDeliveryOutcome =
  | { kind: 'ack' }
  | { kind: 'retry'; reason: EventRetryReason }
  | { kind: 'reject'; reason: EventRejectReason };

export function deliveryOutcome(result: EventAuthorization): EventDeliveryOutcome {
  switch (result.status) {
    case 'accepted':
    case 'duplicate':
      return { kind: 'ack' };
    case 'retry':
      return { kind: 'retry', reason: result.reason };
    case 'rejected':
      return { kind: 'reject', reason: result.reason };
  }
}
