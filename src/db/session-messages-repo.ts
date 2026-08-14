/**
 * `session_messages` — Discord egress と WebUI が共に読む「セッション作業ストリーム」
 * の正本 (spec/feature/session-message-layer.md §3.1)。
 *
 * `UNIQUE(session_id, dedupe_key)` で create/update を判定する。 projector が
 * 決定的に生成した dedupe_key が既にあれば同じ行を UPDATE (`edited_ts` を打つ)、
 * 無ければ新規行を INSERT する。 dedupe_key が null の呼び出しは常に INSERT
 * (SQLite は UNIQUE 制約で NULL 同士を別値として扱う)。
 */

import type Database from "better-sqlite3";
import type {
  Attachment,
  Component,
  Embed,
  SessionMessageAuthorType,
} from "../shared/session-message-types.js";

export interface SessionMessageRow {
  id: number;
  session_id: string;
  ts: number;
  edited_ts: number | null;
  author_type: SessionMessageAuthorType;
  author_label: string;
  author_platform: string | null;
  content: string;
  embeds: Embed[] | null;
  components: Component[] | null;
  attachments: Attachment[] | null;
  reference_id: number | null;
  metadata: Record<string, unknown> | null;
  dedupe_key: string | null;
}

export interface UpsertSessionMessageInput {
  session_id: string;
  ts: number;
  author_type: SessionMessageAuthorType;
  author_label: string;
  author_platform?: string | null;
  content: string;
  embeds?: Embed[] | null;
  components?: Component[] | null;
  attachments?: Attachment[] | null;
  reference_id?: number | null;
  metadata?: Record<string, unknown> | null;
  dedupe_key?: string | null;
}

export interface UpsertSessionMessageResult {
  row: SessionMessageRow;
  op: "create" | "update";
}

interface RawRow {
  id: number;
  session_id: string;
  ts: number;
  edited_ts: number | null;
  author_type: string;
  author_label: string;
  author_platform: string | null;
  content: string;
  embeds: string | null;
  components: string | null;
  attachments: string | null;
  reference_id: number | null;
  metadata: string | null;
  dedupe_key: string | null;
}

export class SessionMessagesRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: UpsertSessionMessageInput): UpsertSessionMessageResult {
    const dedupeKey = input.dedupe_key ?? null;
    const existing = dedupeKey
      ? (this.db
          .prepare(`SELECT id FROM session_messages WHERE session_id = ? AND dedupe_key = ?`)
          .get(input.session_id, dedupeKey) as { id: number } | undefined)
      : undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE session_messages
             SET edited_ts = ?, author_type = ?, author_label = ?, author_platform = ?,
                 content = ?, embeds = ?, components = ?, attachments = ?,
                 reference_id = ?, metadata = ?
           WHERE id = ?`,
        )
        .run(
          input.ts,
          input.author_type,
          input.author_label,
          input.author_platform ?? null,
          input.content,
          jsonOrNull(input.embeds),
          jsonOrNull(input.components),
          jsonOrNull(input.attachments),
          input.reference_id ?? null,
          jsonOrNull(input.metadata),
          existing.id,
        );
      return { row: this.getById(existing.id)!, op: "update" };
    }

    const result = this.db
      .prepare(
        `INSERT INTO session_messages(
           session_id, ts, author_type, author_label, author_platform,
           content, embeds, components, attachments, reference_id, metadata, dedupe_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.session_id,
        input.ts,
        input.author_type,
        input.author_label,
        input.author_platform ?? null,
        input.content,
        jsonOrNull(input.embeds),
        jsonOrNull(input.components),
        jsonOrNull(input.attachments),
        input.reference_id ?? null,
        jsonOrNull(input.metadata),
        dedupeKey,
      );
    return { row: this.getById(Number(result.lastInsertRowid))!, op: "create" };
  }

  getById(id: number): SessionMessageRow | null {
    const row = this.db
      .prepare(`SELECT * FROM session_messages WHERE id = ?`)
      .get(id) as RawRow | undefined;
    return row ? deserialize(row) : null;
  }

  findIdByDedupeKey(session_id: string, dedupe_key: string): number | null {
    const row = this.db
      .prepare(`SELECT id FROM session_messages WHERE session_id = ? AND dedupe_key = ?`)
      .get(session_id, dedupe_key) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * Discord 互換ページング。 `before`/`after` はどちらも id カーソル (排他的)。
   * 両方省略時は最新 `limit` 件を時系列順で返す。 既定 50、 上限 200。
   */
  list(
    session_id: string,
    opts: { before?: number; after?: number; limit?: number } = {},
  ): SessionMessageRow[] {
    const limit = clampLimit(opts.limit);
    if (opts.after != null) {
      const rows = this.db
        .prepare(
          `SELECT * FROM session_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
        )
        .all(session_id, opts.after, limit) as RawRow[];
      return rows.map(deserialize);
    }
    if (opts.before != null) {
      const rows = this.db
        .prepare(
          `SELECT * FROM session_messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        )
        .all(session_id, opts.before, limit) as RawRow[];
      return rows.map(deserialize).reverse();
    }
    const rows = this.db
      .prepare(`SELECT * FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all(session_id, limit) as RawRow[];
    return rows.map(deserialize).reverse();
  }

  /** 未読件数の計算用: `id > since_id` の件数。 */
  countAfter(session_id: string, since_id: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ? AND id > ?`)
      .get(session_id, since_id) as { n: number };
    return row.n;
  }

  latest(session_id: string): SessionMessageRow | null {
    const row = this.db
      .prepare(`SELECT * FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1`)
      .get(session_id) as RawRow | undefined;
    return row ? deserialize(row) : null;
  }

  /**
   * `ProjectContext` の起動時復元用: 直近 tool-use の dedupe_key を新しい順に返す。
   * 再起動でメモリ上の LRU が失われても、直後の tool-result frame が元の tool / Task
   * message を更新し、入力や結果本文を新しい行として再掲しないようにする。
   */
  listRecentToolUseDedupeKeys(
    session_id: string,
    limit: number,
  ): Array<{ dedupe_key: string; metadata: Record<string, unknown> | null }> {
    const rows = this.db
      .prepare(
        `SELECT dedupe_key, metadata FROM session_messages
          WHERE session_id = ? AND author_type IN ('tool', 'task') AND dedupe_key IS NOT NULL
          ORDER BY id DESC LIMIT ?`,
      )
      .all(session_id, limit) as Array<{ dedupe_key: string; metadata: string | null }>;
    return rows.map((r) => ({
      dedupe_key: r.dedupe_key,
      metadata: parseRecordOrNull(r.metadata),
    }));
  }

  /** Storage 管理用: cutoff より古いメッセージを削除する。 */
  purgeOlderThan(cutoffTs: number): number {
    const result = this.db
      .prepare(`DELETE FROM session_messages WHERE COALESCE(edited_ts, ts) < ?`)
      .run(cutoffTs);
    return Number(result.changes ?? 0);
  }
}

function deserialize(row: RawRow): SessionMessageRow {
  return {
    id: row.id,
    session_id: row.session_id,
    ts: row.ts,
    edited_ts: row.edited_ts,
    author_type: row.author_type as SessionMessageAuthorType,
    author_label: row.author_label,
    author_platform: row.author_platform,
    content: row.content,
    embeds: parseArrayOrNull<Embed>(row.embeds),
    components: parseArrayOrNull<Component>(row.components),
    attachments: parseArrayOrNull<Attachment>(row.attachments),
    reference_id: row.reference_id,
    metadata: parseRecordOrNull(row.metadata),
    dedupe_key: row.dedupe_key,
  };
}

function jsonOrNull(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function safeParse(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseArrayOrNull<T>(value: string | null): T[] | null {
  const parsed = safeParse(value);
  return Array.isArray(parsed) ? parsed as T[] : null;
}

function parseRecordOrNull(value: string | null): Record<string, unknown> | null {
  const parsed = safeParse(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}
