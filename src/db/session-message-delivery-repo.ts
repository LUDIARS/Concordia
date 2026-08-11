/**
 * External delivery identifiers for canonical session messages.
 *
 * A message has at most one current representation per platform.  The egress
 * adapter uses this mapping to turn canonical `update` events into platform
 * edits instead of creating another post.
 */

import type Database from "better-sqlite3";

export interface SessionMessageDeliveryRepo {
  findExternalId(messageId: number, platform: string): string | null;
  put(input: { message_id: number; platform: string; external_id: string; ts: number }): void;
}

export function makeSessionMessageDeliveryRepo(db: Database.Database): SessionMessageDeliveryRepo {
  return {
    findExternalId(messageId, platform) {
      const row = db
        .prepare("SELECT external_id FROM session_message_delivery WHERE message_id = ? AND platform = ?")
        .get(messageId, platform) as { external_id: string } | undefined;
      return row?.external_id ?? null;
    },
    put(input) {
      db
        .prepare(
          `INSERT INTO session_message_delivery(message_id, platform, external_id, ts)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(message_id, platform) DO UPDATE SET
             external_id = excluded.external_id,
             ts = excluded.ts`,
        )
        .run(input.message_id, input.platform, input.external_id, input.ts);
    },
  };
}
