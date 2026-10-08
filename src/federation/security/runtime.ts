import type Database from 'better-sqlite3';
import { readWorkloadSecurityConfig, workloadCredential, type WorkloadSecurityConfig } from './config.js';
import { createWorkloadNonceStore } from './nonce-store.js';
import { createWorkloadRequestLedger, type RequestLedgerResult } from './request-ledger.js';
import { authorizeWorkloadRequest } from './authorize.js';
import { introspectWorkload, issueWorkloadToken } from './authority.js';
import { workloadProofHeaders } from './proof.js';
import { eventPermission, parseEventBody, WorkloadEvent } from './events.js';
import { parseSiteEventPayload } from '../remote-session-payload.js';
import type { EventAuthorization } from './event-outcome.js';

export interface WorkloadSecurity {
  prepareEvent(siteId: string, raw: unknown): Promise<unknown>;
  /** 実行可否だけでなく、ack・再配送・拒否のどれで本社へ返すかを決められる結果を返す。 */
  authorizeEvent(raw: unknown, isCurrent: () => boolean): Promise<EventAuthorization>;
  authorizeHq(headers: Record<string, string>, method: string, path: string, body: string): Promise<boolean>;
}
/** Composition boundary owns config; denial leaves existing local services running. */
export function createWorkloadSecurity(db: Database.Database, warn: (message: string) => void): WorkloadSecurity {
  let config: WorkloadSecurityConfig | null = null;
  try { config = readWorkloadSecurityConfig(process.env); }
  catch { warn('workload security configuration invalid; remote privileged actions disabled'); }
  const nonces = createWorkloadNonceStore(db);
  const requests = createWorkloadRequestLedger(db);
  const authorize = (headers: Record<string, string>, method: string, path: string, body: string,
    action: 'ai-spawn' | 'ai-inject' | 'hq-config', resource: string, isCurrent: () => boolean) =>
    authorizeWorkloadRequest({ config, nonces, headers, method, path, body, action, resource,
      now: Date.now, isCurrent, introspect: token => {
        if (!config) throw new Error('workload_security_unconfigured');
        return introspectWorkload(config, token);
      } });
  return {
    async prepareEvent(siteId, raw) {
      const payload = parseSiteEventPayload(raw);
      const audience = config?.sites[siteId];
      if (!config || !audience || !payload) throw new Error('workload_event_unconfigured');
      const permission = eventPermission(payload);
      const token = await issueWorkloadToken(config, audience, permission.action, permission.resource);
      const body = JSON.stringify(payload);
      return { type: 'workload-event', body, headers: workloadProofHeaders({
        privateKey: workloadCredential(config.local.privateKeyEnv), subject: config.local.subject,
        audience, token, method: 'POST', path: '/federation/event', body, now: Date.now(),
      }) };
    },
    async authorizeEvent(raw, isCurrent) {
      const envelope = WorkloadEvent.safeParse(raw);
      if (!envelope.success) return { status: 'rejected', reason: 'invalid_envelope' };
      const { body, headers } = envelope.data;
      const payload = parseEventBody(body);
      if (!payload) return { status: 'rejected', reason: 'invalid_envelope' };
      const permission = eventPermission(payload);
      const result = await authorize(headers, 'POST', '/federation/event', body,
        permission.action, permission.resource, isCurrent);
      if (!result.ok) return result.retryable
        ? { status: 'retry', reason: result.reason }
        : { status: 'rejected', reason: result.reason };
      if (!config) return { status: 'rejected', reason: 'unconfigured' };
      if (!isCurrent()) return { status: 'retry', reason: 'not_current' };
      if (Date.now() >= result.expiresAt) return { status: 'retry', reason: 'stale_proof' };
      const requestId = payload.type === 'spawn' ? `spawn:${payload.channel_id}` : `inject:${payload.message_id}`;
      let recorded: RequestLedgerResult;
      try { recorded = requests.accept(result.subject, config.local.subject, permission.resource, requestId); }
      catch { return { status: 'retry', reason: 'storage_failed' }; }
      if (recorded === 'duplicate') return { status: 'duplicate' };
      if (recorded === 'full') return { status: 'rejected', reason: 'ledger_full' };
      return { status: 'accepted', payload };
    },
    async authorizeHq(headers, method, path, body) {
      const result = await authorize(headers, method, path, body, 'hq-config', 'service:concordia', () => true);
      return result.ok && Date.now() < result.expiresAt;
    },
  };
}
