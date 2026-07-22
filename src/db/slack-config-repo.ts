// Slack 連携設定の key/value 永続化 repo (discord_config / DiscordConfigRepo と対の構成)。
// 値の意味付け (どのキーが token で暗号化必須か等) は slack/config.ts が持つ。
// ここは素の CRUD のみ (SRP)。

import type { Database } from "better-sqlite3";

export interface SlackConfigRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  compareAndSwap(key: string, expected: string | null, value: string | null): boolean;
  all(): Record<string, string>;
}

export function makeSlackConfigRepo(db: Database): SlackConfigRepo {
  return {
    get(key) {
      const row = db.prepare("SELECT value FROM slack_config WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO slack_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },
    delete(key) {
      db.prepare("DELETE FROM slack_config WHERE key = ?").run(key);
    },
    compareAndSwap(key, expected, value) {
      if (expected === null) {
        if (value === null) return !db.prepare("SELECT 1 FROM slack_config WHERE key = ?").get(key);
        return db.prepare(
          `INSERT INTO slack_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
        ).run(key, value).changes === 1;
      }
      if (value === null) {
        return db.prepare("DELETE FROM slack_config WHERE key = ? AND value = ?")
          .run(key, expected).changes === 1;
      }
      return db.prepare("UPDATE slack_config SET value = ? WHERE key = ? AND value = ?")
        .run(value, key, expected).changes === 1;
    },
    all() {
      const rows = db.prepare("SELECT key, value FROM slack_config").all() as {
        key: string;
        value: string;
      }[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },
  };
}
