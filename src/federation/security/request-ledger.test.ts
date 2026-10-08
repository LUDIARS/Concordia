import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkloadRequestLedger } from './request-ledger.js';
import { deliveryOutcome } from './event-outcome.js';

describe('workload request ledger', () => {
  const databases: Database.Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  function ledger() {
    const db = new Database(':memory:'); databases.push(db);
    return { db, ledger: createWorkloadRequestLedger(db) };
  }
  it('distinguishes first acceptance from an already processed redelivery', () => {
    const { ledger: l } = ledger();
    expect(l.accept('hq', 'site', 'thread:1:2', 'spawn:2')).toBe('accepted');
    expect(l.accept('hq', 'site', 'thread:1:2', 'spawn:2')).toBe('duplicate');
    expect(l.accept('hq', 'site', 'thread:1:3', 'spawn:3')).toBe('accepted');
  });
  it('reports a full ledger only for new requests, still recognising processed ones', () => {
    const { db, ledger: l } = ledger();
    expect(l.accept('hq', 'site', 'thread:1:2', 'spawn:2')).toBe('accepted');
    const insert = db.prepare('INSERT INTO federation_workload_requests VALUES (?, ?, ?, ?)');
    db.transaction(() => { for (let i = 0; i < 999_999; i++) insert.run('hq', 'site', 'thread:x', `fill:${i}`); })();
    expect(l.accept('hq', 'site', 'thread:1:2', 'spawn:2')).toBe('duplicate');
    expect(l.accept('hq', 'site', 'thread:1:9', 'spawn:9')).toBe('full');
  });
});

describe('event delivery outcome', () => {
  it('acks only processed requests and keeps others out of the ack path', () => {
    expect(deliveryOutcome({ status: 'duplicate' })).toEqual({ kind: 'ack' });
    expect(deliveryOutcome({ status: 'accepted', payload: {} as never })).toEqual({ kind: 'ack' });
    expect(deliveryOutcome({ status: 'retry', reason: 'authority_unavailable' })).toEqual({ kind: 'retry', reason: 'authority_unavailable' });
    expect(deliveryOutcome({ status: 'rejected', reason: 'grant_mismatch' })).toEqual({ kind: 'reject', reason: 'grant_mismatch' });
  });
});
