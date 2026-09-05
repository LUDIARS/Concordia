// GitHub 連携設定の key/value 永続化 repo (revisor-config-repo と対の構成)。
// 値の意味付け (どのキーが secret で暗号化必須か) は github/config.ts が持つ。
// ここは素の CRUD のみ (SRP)。
// @implements spec/feature/github-issue-workflow.md — 設定

import type { Database } from "better-sqlite3";

export interface GithubConfigRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function makeGithubConfigRepo(db: Database): GithubConfigRepo {
  return {
    get(key) {
      const row = db.prepare("SELECT value FROM github_config WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    set(key, value) {
      db.prepare(
        `INSERT INTO github_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },
    delete(key) {
      db.prepare("DELETE FROM github_config WHERE key = ?").run(key);
    },
  };
}
