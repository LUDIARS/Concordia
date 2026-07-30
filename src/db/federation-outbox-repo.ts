/**
 * federation_outbox — 拠点別の切断中イベントキュー (本社側)。
 *
 * seq (AUTOINCREMENT) の昇順配送で順序を保証する。拠点は受領済み最大 seq を
 * ack し、本社は当該拠点の seq 以下を削除する。
 *
 * 上限 (行数 + TTL) を持ち、超過は最古から破棄する (spec 障害モード
 * 「長時間切断でキュー溢れ」)。破棄件数は enqueue の戻り値で返し、呼び出し側が
 * エラーチャンネル通知 (reportError) する。
 */

import type Database from "better-sqlite3";

export interface FederationOutboxRow {
  seq: number;
  site_id: string;
  payload: string;
  created_at: number;
}

export interface FederationOutboxLimits {
  maxRows: number;
  ttlSec: number;
}

export interface FederationOutboxRepo {
  /** payload は JSON 文字列化して保存。戻り値 dropped は上限/TTL で破棄した行数。 */
  enqueue(siteId: string, payload: unknown): { seq: number; dropped: number };
  listPending(siteId: string, afterSeq: number, limit: number): FederationOutboxRow[];
  /** seq 以下を受領済みとして削除。 */
  ackUpTo(siteId: string, seq: number): number;
  pendingCount(siteId: string): number;
}

export function makeFederationOutboxRepo(
  db: Database.Database,
  limits: FederationOutboxLimits,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): FederationOutboxRepo {
  // prune は enqueue のたびに走る。 大半の呼び出しでは 1 件も破棄されないので、
  // 「破棄が要るか」の判定を idx(site_id, seq) で O(1) 〜 index-only に抑える
  // (better-sqlite3 は同期 API = ここのコストがそのままイベントループを塞ぐ)。
  function prune(siteId: string, now: number): number {
    const cutoff = now - limits.ttlSec;
    // created_at は seq と同じ順に増える (append only) ので、最古行が期限内なら
    // 期限切れは 1 件も無い。 created_at に索引が無いため、この足切りが無いと
    // 毎回キュー全行 (既定 10000 行) を読むことになる。
    const oldest = db.prepare(
      "SELECT created_at FROM federation_outbox WHERE site_id = ? ORDER BY seq LIMIT 1",
    ).get(siteId) as { created_at: number } | undefined;
    const ttlChanges = oldest && oldest.created_at < cutoff
      ? db.prepare(
          "DELETE FROM federation_outbox WHERE site_id = ? AND created_at < ?",
        ).run(siteId, cutoff).changes
      : 0;
    // 新しい順に maxRows 件読み飛ばした先頭 = 破棄対象の上限 seq。 該当が無い
    // (= 行数が上限以下) なら COALESCE が -1 を返し 1 行も消さない。 NOT IN で
    // 上限件数ぶんの一時集合を毎回組むより安い。
    const overflow = db.prepare(
      `DELETE FROM federation_outbox WHERE site_id = ? AND seq <= COALESCE(
         (SELECT seq FROM federation_outbox WHERE site_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?), -1
       )`,
    ).run(siteId, siteId, limits.maxRows);
    return ttlChanges + overflow.changes;
  }

  return {
    enqueue(siteId, payload) {
      const result = db.prepare(
        "INSERT INTO federation_outbox (site_id, payload, created_at) VALUES (?, ?, ?)",
      ).run(siteId, JSON.stringify(payload ?? null), nowSec());
      const dropped = prune(siteId, nowSec());
      return { seq: Number(result.lastInsertRowid), dropped };
    },
    listPending(siteId, afterSeq, limit) {
      return db.prepare(
        "SELECT * FROM federation_outbox WHERE site_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      ).all(siteId, afterSeq, limit) as FederationOutboxRow[];
    },
    ackUpTo(siteId, seq) {
      return db.prepare(
        "DELETE FROM federation_outbox WHERE site_id = ? AND seq <= ?",
      ).run(siteId, seq).changes;
    },
    pendingCount(siteId) {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM federation_outbox WHERE site_id = ?",
      ).get(siteId) as { n: number };
      return row.n;
    },
  };
}
