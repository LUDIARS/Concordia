import type Database from "better-sqlite3";

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  getBoolean(key: string, fallback: boolean): boolean;
  setBoolean(key: string, value: boolean): void;
}

export class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`).run(key, value);
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const raw = this.get(key);
    return raw === null ? fallback : raw === "1" || raw === "true";
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? "1" : "0");
  }
}
