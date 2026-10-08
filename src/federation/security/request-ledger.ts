import type Database from 'better-sqlite3';

export type RequestLedgerResult = 'accepted' | 'duplicate' | 'full';

/** A fresh proof on outbox redelivery must not repeat a previously accepted operation. */
export function createWorkloadRequestLedger(db: Database.Database): {
  accept(subject: string, audience: string, resource: string, requestId: string): RequestLedgerResult;
} {
  db.exec(`CREATE TABLE IF NOT EXISTS federation_workload_requests (
    subject TEXT NOT NULL, audience TEXT NOT NULL, resource TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY(subject, audience, resource, request_id)
  )`);
  const insert = db.prepare('INSERT OR IGNORE INTO federation_workload_requests VALUES (?, ?, ?, ?)');
  const count = db.prepare('SELECT count(*) AS n FROM federation_workload_requests');
  const exists = db.prepare('SELECT 1 FROM federation_workload_requests WHERE subject = ? AND audience = ? AND resource = ? AND request_id = ?');
  const accept = db.transaction((subject: string, audience: string, resource: string, requestId: string): RequestLedgerResult => {
    // Never evict accepted requests automatically: unknown effects require reconciliation.
    // 受理済みの重複は処理済みとして ack できる。上限到達は新規だけを止める。
    if (exists.get(subject, audience, resource, requestId)) return 'duplicate';
    if ((count.get() as { n: number }).n >= 1_000_000) return 'full';
    return insert.run(subject, audience, resource, requestId).changes === 1 ? 'accepted' : 'duplicate';
  });
  return { accept };
}
