/**
 * 巡回チャットの知識の永続 (spec/feature/patrol-chat.md「知識」、 migration 142)。
 * - 断片: 出典 (種類・題・URL / リポ・パス)・公開範囲・更新時刻を持つ。 同じ doc_key の断片はまとめて置き換える
 * - 取り込みの状態: 種類ごとに最終試行・最終成功・失敗理由・差分取得の起点
 */

import type Database from "better-sqlite3";
import type { KnowledgeChunk, KnowledgeDocType, KnowledgeScope, KnowledgeSourceKind } from "../rules/knowledge-types.js";

export interface KnowledgeChunkInput {
  doc_type: KnowledgeDocType;
  doc_key: string;
  seq: number;
  title: string;
  url: string | null;
  repo: string | null;
  path: string | null;
  scope: KnowledgeScope;
  body: string;
  source_updated_at: number | null;
}

export interface KnowledgeSourceRow {
  source_kind: KnowledgeSourceKind;
  last_attempt_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  cursor: string | null;
}

export interface KnowledgeCountRow {
  source_kind: KnowledgeSourceKind;
  doc_type: KnowledgeDocType;
  scope: KnowledgeScope;
  chunks: number;
  docs: number;
}

export class ChatKnowledgeRepo {
  constructor(private readonly db: Database.Database) {}

  /** 種類の断片を丸ごと置き換える (全件取得のとき)。 */
  replaceAll(kind: KnowledgeSourceKind, chunks: KnowledgeChunkInput[], fetchedAt: number): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chat_knowledge_chunks WHERE source_kind = ?`).run(kind);
      this.insertMany(kind, chunks, fetchedAt);
    })();
  }

  /** 届いた文書 (doc_key) の断片だけを置き換える (差分取得のとき)。 */
  replaceDocs(kind: KnowledgeSourceKind, docKeys: string[], chunks: KnowledgeChunkInput[], fetchedAt: number): void {
    this.db.transaction(() => {
      const del = this.db.prepare(`DELETE FROM chat_knowledge_chunks WHERE source_kind = ? AND doc_key = ?`);
      for (const key of new Set(docKeys)) del.run(kind, key);
      this.insertMany(kind, chunks, fetchedAt);
    })();
  }

  private insertMany(kind: KnowledgeSourceKind, chunks: KnowledgeChunkInput[], fetchedAt: number): void {
    const insert = this.db.prepare(`
      INSERT INTO chat_knowledge_chunks
        (source_kind, doc_type, doc_key, seq, title, url, repo, path, scope, body, source_updated_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_key, seq) DO UPDATE SET
        source_kind = excluded.source_kind, doc_type = excluded.doc_type, title = excluded.title, url = excluded.url,
        repo = excluded.repo, path = excluded.path, scope = excluded.scope, body = excluded.body,
        source_updated_at = excluded.source_updated_at, fetched_at = excluded.fetched_at
    `);
    for (const c of chunks) {
      insert.run(kind, c.doc_type, c.doc_key, c.seq, c.title, c.url, c.repo, c.path, c.scope, c.body, c.source_updated_at, fetchedAt);
    }
  }

  /** 選択の対象。 `public` だけを求められたら hq の断片は読まない。 */
  list(opts: { publicOnly: boolean }): KnowledgeChunk[] {
    const where = opts.publicOnly ? `WHERE scope = 'public'` : "";
    return this.db.prepare(`SELECT * FROM chat_knowledge_chunks ${where} ORDER BY doc_key, seq`).all() as KnowledgeChunk[];
  }

  counts(): KnowledgeCountRow[] {
    return this.db.prepare(`
      SELECT source_kind, doc_type, scope, COUNT(*) AS chunks, COUNT(DISTINCT doc_key) AS docs
      FROM chat_knowledge_chunks GROUP BY source_kind, doc_type, scope ORDER BY source_kind, doc_type, scope
    `).all() as KnowledgeCountRow[];
  }

  source(kind: KnowledgeSourceKind): KnowledgeSourceRow | null {
    return (this.db.prepare(`SELECT * FROM chat_knowledge_sources WHERE source_kind = ?`).get(kind) as KnowledgeSourceRow | undefined) ?? null;
  }

  markAttempt(kind: KnowledgeSourceKind, at: number): void {
    this.db.prepare(`
      INSERT INTO chat_knowledge_sources (source_kind, last_attempt_at) VALUES (?, ?)
      ON CONFLICT(source_kind) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
    `).run(kind, at);
  }

  markSuccess(kind: KnowledgeSourceKind, cursor: string | null, at: number): void {
    this.db.prepare(`
      INSERT INTO chat_knowledge_sources (source_kind, last_attempt_at, last_success_at, last_error, cursor) VALUES (?, ?, ?, NULL, ?)
      ON CONFLICT(source_kind) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = NULL, cursor = excluded.cursor
    `).run(kind, at, at, cursor);
  }

  /** 失敗理由だけを残す。 断片と最終成功・差分の起点は前回のまま。 */
  markFailure(kind: KnowledgeSourceKind, error: string, at: number): void {
    this.db.prepare(`
      INSERT INTO chat_knowledge_sources (source_kind, last_attempt_at, last_error) VALUES (?, ?, ?)
      ON CONFLICT(source_kind) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error
    `).run(kind, at, error);
  }
}
