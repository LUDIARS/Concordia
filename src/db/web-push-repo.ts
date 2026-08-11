import type Database from "better-sqlite3";

export interface WebPushSubscriptionRow {
  endpoint: string;
  client_id: string;
  p256dh: string;
  auth: string;
  fail_count: number;
}

/** @implements spec/feature/session-message-webui-chat.md §1.4 */
export class WebPushRepo {
  constructor(private readonly db: Database.Database) {}

  getConfig(key: string): string | null {
    return (this.db.prepare("SELECT value FROM web_push_config WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  setConfig(key: string, value: string): void {
    this.db.prepare("INSERT INTO web_push_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  upsert(input: Omit<WebPushSubscriptionRow, "fail_count">, now: number): void {
    this.db.prepare(`INSERT INTO web_push_subscriptions(endpoint, client_id, p256dh, auth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET client_id=excluded.client_id, p256dh=excluded.p256dh,
        auth=excluded.auth, updated_at=excluded.updated_at, fail_count=0, disabled_at=NULL`).run(input.endpoint, input.client_id, input.p256dh, input.auth, now, now);
  }

  listActive(): WebPushSubscriptionRow[] {
    return this.db.prepare("SELECT endpoint, client_id, p256dh, auth, fail_count FROM web_push_subscriptions WHERE disabled_at IS NULL").all() as WebPushSubscriptionRow[];
  }

  delete(endpoint: string, clientId?: string): void {
    if (clientId === undefined) {
      this.db.prepare("DELETE FROM web_push_subscriptions WHERE endpoint = ?").run(endpoint);
      return;
    }
    this.db.prepare("DELETE FROM web_push_subscriptions WHERE endpoint = ? AND client_id = ?").run(endpoint, clientId);
  }

  recordSuccess(endpoint: string): void {
    this.db.prepare("UPDATE web_push_subscriptions SET fail_count = 0 WHERE endpoint = ? AND fail_count <> 0").run(endpoint);
  }

  recordFailure(endpoint: string, now: number): void {
    this.db.prepare("UPDATE web_push_subscriptions SET fail_count = fail_count + 1, updated_at = ?, disabled_at = CASE WHEN fail_count + 1 >= 5 THEN ? ELSE disabled_at END WHERE endpoint = ?").run(now, now, endpoint);
  }
}
