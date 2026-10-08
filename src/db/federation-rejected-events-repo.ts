/**
 * federation_outbox_rejected — 拠点が実行を拒否した依頼の退避表 (本社側)。
 *
 * ack で消すと依頼が黙って失われるため、event-rejected を受けた outbox 行を
 * 理由コード付きでここへ移す。自動削除しない。管理者が照合して再依頼する
 * (spec/feature/cc-workload-security.md「配送結果の区別」)。
 *
 * 表は同じ機能の nonce / 要求台帳と同じく、この adapter が初回に作る。
 */

import type Database from "better-sqlite3";

export interface FederationRejectedEventRow {
  seq: number;
  site_id: string;
  payload: string;
  reason: string;
  created_at: number;
  rejected_at: number;
}

export interface FederationRejectedEventsRepo {
  /**
   * outbox の (siteId, seq) 行を退避表へ移す。行が無ければ (送っていない seq・既に処理済み) null。
   * 移動は 1 トランザクションで行い、片方だけに残る状態を作らない。
   */
  moveFromOutbox(siteId: string, seq: number, reason: string): FederationRejectedEventRow | null;
  list(siteId?: string): FederationRejectedEventRow[];
}

export function makeFederationRejectedEventsRepo(
  db: Database.Database,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): FederationRejectedEventsRepo {
  db.exec(`CREATE TABLE IF NOT EXISTS federation_outbox_rejected (
    site_id     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    payload     TEXT NOT NULL,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    rejected_at INTEGER NOT NULL,
    PRIMARY KEY(site_id, seq)
  )`);
  const find = db.prepare("SELECT seq, site_id, payload, created_at FROM federation_outbox WHERE site_id = ? AND seq = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO federation_outbox_rejected VALUES (?, ?, ?, ?, ?, ?)");
  const remove = db.prepare("DELETE FROM federation_outbox WHERE site_id = ? AND seq = ?");
  const move = db.transaction((siteId: string, seq: number, reason: string): FederationRejectedEventRow | null => {
    const row = find.get(siteId, seq) as Omit<FederationRejectedEventRow, "reason" | "rejected_at"> | undefined;
    if (!row) return null;
    const rejectedAt = nowSec();
    insert.run(row.site_id, row.seq, row.payload, reason, row.created_at, rejectedAt);
    remove.run(siteId, seq);
    return { ...row, reason, rejected_at: rejectedAt };
  });
  return {
    moveFromOutbox: (siteId, seq, reason) => move(siteId, seq, reason),
    list(siteId) {
      return (siteId
        ? db.prepare("SELECT * FROM federation_outbox_rejected WHERE site_id = ? ORDER BY seq").all(siteId)
        : db.prepare("SELECT * FROM federation_outbox_rejected ORDER BY site_id, seq").all()) as FederationRejectedEventRow[];
    },
  };
}
