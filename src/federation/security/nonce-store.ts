import type Database from 'better-sqlite3';

export interface WorkloadNonceStore {
  consume(subject: string, audience: string, nonce: string, expiresAt: number, now: number): boolean;
}
/** Owned by federation; no timer, and records survive restart until token expiry. */
export function createWorkloadNonceStore(db: Database.Database): WorkloadNonceStore {
  db.exec(`CREATE TABLE IF NOT EXISTS federation_workload_nonces (
    subject TEXT NOT NULL, audience TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(subject, audience, nonce)
  ); CREATE INDEX IF NOT EXISTS federation_workload_nonces_expiry ON federation_workload_nonces(expires_at)`);
  const purge = db.prepare('DELETE FROM federation_workload_nonces WHERE expires_at <= ?');
  const insert = db.prepare('INSERT OR IGNORE INTO federation_workload_nonces VALUES (?, ?, ?, ?)');
  const count = db.prepare('SELECT count(*) AS n FROM federation_workload_nonces');
  const consume = db.transaction((subject: string, audience: string, nonce: string, expiresAt: number, now: number) => {
    purge.run(now);
    if (expiresAt <= now || (count.get() as { n: number }).n >= 100_000) return false;
    return insert.run(subject, audience, nonce, expiresAt).changes === 1;
  });
  return { consume };
}
