import type Database from "better-sqlite3";
import type { SecretBox } from "../shared/secret-box.js";
import { isEncrypted } from "../shared/secret-box.js";

export interface SettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /**
   * 上書きを消して env / 既定へ戻す。 空文字を書くのではなく行ごと消す
   * (空文字が残ると 「DB 由来の空値」 として env フォールバックを塞いでしまう)。
   */
  delete(key: string): void;
  /** 同じ SQLite 接続を使う複数ストアの更新を 1 transaction に束ねる。 */
  transaction<T>(update: () => T): T;
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

  delete(key: string): void {
    this.db.prepare(`DELETE FROM schema_meta WHERE key = ?`).run(key);
  }

  transaction<T>(update: () => T): T {
    return this.db.transaction(update)();
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const raw = this.get(key);
    return raw === null ? fallback : raw === "1" || raw === "true";
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? "1" : "0");
  }
}

/**
 * Cc のユーザー設定を schema_meta に暗号化して保存するアダプタ。
 *
 * 既存の平文は最初の読出し時に暗号化し直す。設定を捨てたり既定値へ黙って
 * フォールバックしたりせず、鍵違い・改竄は呼出元へ明示的に伝える。
 */
export class EncryptedSettingsStore implements SettingsStore {
  constructor(private readonly inner: SettingsStore, private readonly secretBox: SecretBox) {}

  get(key: string): string | null {
    const stored = this.inner.get(key);
    if (stored === null) return null;
    if (!isEncrypted(stored)) {
      this.inner.set(key, this.secretBox.encrypt(stored));
      return stored;
    }
    try {
      return this.secretBox.decrypt(stored);
    } catch {
      throw new Error(`cannot decrypt persisted setting: ${key}`);
    }
  }

  set(key: string, value: string): void {
    this.inner.set(key, this.secretBox.encrypt(value));
  }

  delete(key: string): void {
    this.inner.delete(key);
  }

  transaction<T>(update: () => T): T {
    return this.inner.transaction(update);
  }

  getBoolean(key: string, fallback: boolean): boolean {
    const raw = this.get(key);
    return raw === null ? fallback : raw === "1" || raw === "true";
  }

  setBoolean(key: string, value: boolean): void {
    this.set(key, value ? "1" : "0");
  }
}
