/**
 * OKF タグの保存 (spec/feature/slack-knowledge-search.md KS-5)。
 *
 * 文書の鍵ごとに本文ハッシュと OKF タグを持つ。 ハッシュが変わったら付け直しの対象。
 * SRP: knowledge_search_tags の読み書きだけ。
 */

import type { Database } from "better-sqlite3";
import { makeOkfTags, type OkfTags } from "./okf.js";

export interface TagRecord {
  bodyHash: string;
  okf: OkfTags | null;
  attempts: number;
}

export function knowledgeSearchTagStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_search_tags (
    doc_key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, okf TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  const select = db.prepare("SELECT body_hash, okf, attempts FROM knowledge_search_tags WHERE doc_key = ?");
  const upsert = db.prepare(`INSERT INTO knowledge_search_tags (doc_key, body_hash, okf, attempts, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(doc_key) DO UPDATE SET body_hash = excluded.body_hash, okf = excluded.okf, attempts = excluded.attempts, updated_at = excluded.updated_at`);
  const parse = (json: string | null): OkfTags | null => {
    if (!json) return null;
    try { return makeOkfTags(JSON.parse(json) as OkfTags); } catch { return null; }
  };
  return {
    get(docKey: string): TagRecord | null {
      const row = select.get(docKey) as { body_hash: string; okf: string | null; attempts: number } | undefined;
      return row ? { bodyHash: row.body_hash, okf: parse(row.okf), attempts: row.attempts } : null;
    },
    /** 付与に成功したタグを保存する (試行回数は 0 に戻す)。 */
    put(docKey: string, bodyHash: string, okf: OkfTags, nowSec: number): void {
      upsert.run(docKey, bodyHash, JSON.stringify(okf), 0, nowSec);
    },
    /** 付与に失敗したことを記録する (同じハッシュなら試行回数を足す)。 */
    fail(docKey: string, bodyHash: string, nowSec: number): void {
      const prev = this.get(docKey);
      const attempts = prev && prev.bodyHash === bodyHash ? prev.attempts + 1 : 1;
      upsert.run(docKey, bodyHash, null, attempts, nowSec);
    },
  };
}
export type KnowledgeSearchTagStore = ReturnType<typeof knowledgeSearchTagStore>;
