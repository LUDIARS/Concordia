/**
 * transcript_logs — Lictor の transcript-tail が送る Claude/Codex JSONL frame の
 * per-session 永続ストレージ.
 *
 * 設計メモ:
 *  - session_events (discrete signal) とは別 table に分離.
 *    1 session で数百〜数千 frame になり得るので、 events feed の S/N を保つため.
 *  - (session_id, seq) UNIQUE で冪等性確保. tail の再送 / 重複 POST を吸収.
 *  - kind は Lictor の transcript-tail が抽出する `text` / `tool-use` /
 *    `tool-result` / `thinking` / `summary` / `system` / `raw` のいずれか.
 *  - payload は frame の raw object を JSON 文字列化したもの.
 */

import type Database from "better-sqlite3";

export interface TranscriptLogRow {
  id: number;
  session_id: string;
  seq: number;
  ts: number;
  kind: string;
  /** Raw JSON string. listBySession の戻り値では parse 済 unknown に変換される. */
  payload: string;
}

export interface TranscriptLogEntry {
  id: number;
  seq: number;
  ts: number;
  kind: string;
  payload: unknown;
}

export class TranscriptLogsRepo {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert one transcript frame.
   *
   * UNIQUE(session_id, seq) 違反 (= 重複 POST) は黙って ignore する.
   * Lictor の transcript sink は timeout / ネットワーク失敗時に same seq で
   * 再送する (at-least-once)。 再送の 1 回目が実はサーバに届いていた場合、
   * 2 回目は重複になる — これは呼び出し側から見れば「永続化は完了している」
   * 正常系なので、 戻り値は「新規挿入か」ではなく **「行が存在するか」** を返す
   * (冪等成功)。 重複を false で返すと、 requirePersisted な書き手 (codex
   * bootstrap の session binding) が再送のたびに失敗する (2026-07-12 実障害)。
   */
  insert(input: {
    session_id: string;
    seq: number;
    ts: number;
    kind: string;
    payload: unknown;
  }): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO transcript_logs(session_id, seq, ts, kind, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.session_id,
        input.seq,
        input.ts,
        input.kind,
        JSON.stringify(input.payload ?? null),
      );
    if (result.changes > 0) return true;
    // IGNORE された = ほぼ確実に UNIQUE(session_id, seq) 重複。 既存行が
    // あることを確認できれば冪等成功として true を返す。
    const row = this.db
      .prepare(`SELECT 1 AS x FROM transcript_logs WHERE session_id = ? AND seq = ?`)
      .get(input.session_id, input.seq);
    return row !== undefined;
  }

  /**
   * Paginated listing for a session.
   *
   * 並び順は `ts ASC, seq ASC` (chronological). web monitor が読みやすい順.
   * since_id を指定すると id > since_id の行だけを返す (incremental tail 用).
   *
   * tail=true (かつ since_id 未指定) のときは「最新 limit 件」を時系列順で返す.
   *   数千 frame あるセッションを開いたとき、 先頭 (起動直後の raw frame) ではなく
   *   直近の作業が見えるようにするための既定モード. 内側で DESC LIMIT して新しい順に
   *   切り出し、 外側で ASC に並べ直す (表示は chronological のまま).
   * since_id 指定時は incremental tail なので tail は無視する (古い→新しいで積み増す).
   */
  listBySession(
    session_id: string,
    opts: { since_id?: number; limit?: number; tail?: boolean } = {},
  ): TranscriptLogEntry[] {
    const limit = clampLimit(opts.limit);
    const hasSince =
      typeof opts.since_id === "number" && Number.isFinite(opts.since_id);

    let rows: Array<{ id: number; seq: number; ts: number; kind: string; payload: string }>;
    if (opts.tail && !hasSince) {
      rows = this.db
        .prepare(
          `SELECT id, seq, ts, kind, payload FROM (
             SELECT id, seq, ts, kind, payload FROM transcript_logs
              WHERE session_id = ?
              ORDER BY ts DESC, seq DESC
              LIMIT ?
           ) ORDER BY ts ASC, seq ASC`,
        )
        .all(session_id, limit) as typeof rows;
    } else {
      const params: unknown[] = [session_id];
      let sql = `SELECT id, seq, ts, kind, payload FROM transcript_logs WHERE session_id = ?`;
      if (hasSince) {
        sql += ` AND id > ?`;
        params.push(opts.since_id);
      }
      sql += ` ORDER BY ts ASC, seq ASC LIMIT ?`;
      params.push(limit);
      rows = this.db.prepare(sql).all(...params) as typeof rows;
    }

    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      payload: safeParse(r.payload),
    }));
  }

  /**
   * Min/Max ts for a session (null if no frames).
   * session 行が purge 済みでも transcript が残っている孤児セッションに対し、
   * 閲覧用の synthetic session (開始/終了時刻) を組み立てるのに使う.
   */
  tsSpan(session_id: string): { first_ts: number; last_ts: number } | null {
    const row = this.db
      .prepare(
        `SELECT MIN(ts) AS f, MAX(ts) AS l FROM transcript_logs WHERE session_id = ?`,
      )
      .get(session_id) as { f: number | null; l: number | null };
    if (row.f == null || row.l == null) return null;
    return { first_ts: row.f, last_ts: row.l };
  }

  /**
   * Highest row id for a session (0 if none).
   * compaction の elicit が inject 前の watermark を取り、 以後の frame だけ捕捉するのに使う.
   */
  maxId(session_id: string): number {
    const row = this.db
      .prepare(`SELECT MAX(id) AS m FROM transcript_logs WHERE session_id = ?`)
      .get(session_id) as { m: number | null };
    return row.m ?? 0;
  }

  countBySession(session_id: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM transcript_logs WHERE session_id = ?`)
      .get(session_id) as { n: number };
    return row.n;
  }

  /** Storage 管理用: 全 session の cutoff より古い frame を削除する. */
  purgeOlderThan(cutoffTs: number): number {
    const result = this.db.prepare(`DELETE FROM transcript_logs WHERE ts < ?`).run(cutoffTs);
    return Number(result.changes ?? 0);
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 200;
  return Math.min(Math.floor(n), 1000);
}
