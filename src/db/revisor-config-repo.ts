// Revisor 連携設定の key/value 永続化 repo (slack-config-repo / SlackConfigRepo と対の構成)。
// 値の意味付け (どのキーが token で暗号化必須か等) は pr/revisor-config.ts が持つ。
// ここは素の CRUD のみ (SRP)。
// @implements spec/feature/revisor-local-pr-submission.md — 6. token

import type { Database } from "better-sqlite3";

export interface RevisorConfigRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function makeRevisorConfigRepo(db: Database): RevisorConfigRepo {
  return {
    get(key) {
      const row = db.prepare("SELECT value FROM revisor_config WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO revisor_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },
    delete(key) {
      db.prepare("DELETE FROM revisor_config WHERE key = ?").run(key);
    },
  };
}
