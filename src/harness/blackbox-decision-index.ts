/**
 * blackbox_decisions の (domain, id) 索引を Concordia 側で張る (FS-11 P0-a / CC-SCAN-01)。
 *
 * 表の持ち主は外部パッケージ @ludiars/blackbox で、 schema は makeSqliteBlackBox 内の
 * ensureBlackboxSchema が作る。 そのため Concordia の migration 台帳 (src/db/schema.ts) には
 * 載せられない (新規 DB では migration の時点で表がまだ無く、 索引を張れない穴が残る)。
 * パッケージの ensure の直後にここで 1 文だけ流す。
 *
 * 理由: listRecent は `WHERE domain=? ORDER BY id DESC LIMIT ?` だが、 既存索引は
 * (domain, created_at) なので domain の全行を読んで TEMP B-TREE で並べ替えていた
 * (gate 7 万行で 1 回 0.7〜1.1 秒の同期停止)。 (domain, id) の昇順索引なら DESC は逆走査で済む。
 *
 * 上流の ensureBlackboxSchema が同じ索引を採るときは、 必ずこの名前・この列にそろえる。
 * 名前が違うと同じ中身の索引が 2 本でき、 書き込みが二重になる。
 */
import type Database from "better-sqlite3";

export const BLACKBOX_DECISIONS_DOMAIN_ID_INDEX = "idx_blackbox_decisions_domain_id";

export function ensureBlackboxDecisionDomainIdIndex(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${BLACKBOX_DECISIONS_DOMAIN_ID_INDEX} ON blackbox_decisions(domain, id)`,
  );
}
