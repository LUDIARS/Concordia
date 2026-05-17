import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

let cachedHostId: string | null = null;

/**
 * Excubitor が動いているマシンの host レコードを upsert して id を返す。
 * v0.1 では同居 agent (server 自身) を 1 つの host として扱う。
 */
export async function getOrCreateLocalHost(): Promise<string> {
  if (cachedHostId) return cachedHostId;

  const hostname = os.hostname();
  // PG の data-modifying CTE (INSERT/UPDATE in WITH) は SQLite だと素直に書けないので、
  // 二段階に分解する: 先に SELECT、 無ければ INSERT、 あれば UPDATE。
  const existing = db().get(sql`SELECT id FROM hosts WHERE hostname = ${hostname}`) as { id: string } | undefined;
  if (existing) {
    db().run(sql`
      UPDATE hosts SET last_heartbeat_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
      WHERE hostname = ${hostname}
    `);
    cachedHostId = existing.id;
    return cachedHostId;
  }
  const newId = randomUUID();
  db().run(sql`
    INSERT INTO hosts (id, name, hostname, agent_version, last_heartbeat_at)
    VALUES (${newId}, ${hostname}, ${hostname}, ${'0.1.0-local'}, unixepoch() * 1000)
  `);
  cachedHostId = newId;
  return cachedHostId;
}

export async function heartbeatLocalHost(): Promise<void> {
  const hostname = os.hostname();
  db().run(sql`
    UPDATE hosts SET last_heartbeat_at = unixepoch() * 1000, updated_at = unixepoch() * 1000
    WHERE hostname = ${hostname}
  `);
}
