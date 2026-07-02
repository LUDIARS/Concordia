/**
 * service_test_claims — 「いま何が起動テスト / 再起動中か」 の宣言レジストリ。
 *
 * セッションはサービスの再起動・起動テストを行う前に claim を宣言し、 終わったら
 * release する。 Concordia はこれを正本に交通整備する (同一サービスへの並行テストを
 * 検知して両セッションへ警告 inject、 現況の一覧提供)。
 * claim は強制ロックではなく宣言 (advisory)。 強制は目的でなく、 衝突の可視化が目的。
 */

import type { Database } from "better-sqlite3";

export interface TestClaimRow {
  id: number;
  service: string;
  session_id: string;
  branch: string | null;
  note: string;
  started_at: number;
  released_at: number | null;
}

/** これより古い未 release の claim は放置とみなして自動失効させる (秒)。 */
export const TEST_CLAIM_TTL_SEC = 60 * 60;

export class TestingClaimsRepo {
  constructor(private readonly db: Database) {}

  /**
   * claim を宣言する。 同一サービスを他セッションがテスト中なら、 その claim を
   * conflict として返す (宣言自体は成立させる — 交通整備は警告で行う)。
   * 同一セッションの同一サービス既存 claim は上書き (release → 新規)。
   */
  claim(input: { service: string; session_id: string; branch?: string | null; note?: string; now: number }): {
    claim: TestClaimRow;
    conflicts: TestClaimRow[];
  } {
    const cutoff = input.now - TEST_CLAIM_TTL_SEC;
    const conflicts = (this.db
      .prepare(
        `SELECT * FROM service_test_claims
         WHERE service = ? AND session_id != ? AND released_at IS NULL AND started_at > ?`,
      )
      .all(input.service, input.session_id, cutoff) as TestClaimRow[]);
    this.db
      .prepare(
        `UPDATE service_test_claims SET released_at = ?
         WHERE service = ? AND session_id = ? AND released_at IS NULL`,
      )
      .run(input.now, input.service, input.session_id);
    const r = this.db
      .prepare(
        `INSERT INTO service_test_claims (service, session_id, branch, note, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.service, input.session_id, input.branch ?? null, input.note ?? "", input.now);
    const claim = this.db
      .prepare(`SELECT * FROM service_test_claims WHERE id = ?`)
      .get(r.lastInsertRowid) as TestClaimRow;
    return { claim, conflicts };
  }

  /** release する。 service 省略時はそのセッションの全 claim。 解放件数を返す。 */
  release(sessionId: string, service: string | null, now: number): number {
    if (service) {
      return this.db
        .prepare(
          `UPDATE service_test_claims SET released_at = ?
           WHERE session_id = ? AND service = ? AND released_at IS NULL`,
        )
        .run(now, sessionId, service).changes;
    }
    return this.db
      .prepare(
        `UPDATE service_test_claims SET released_at = ? WHERE session_id = ? AND released_at IS NULL`,
      )
      .run(now, sessionId).changes;
  }

  /** active な claim 一覧 (TTL 内 & 未 release)。 */
  listActive(now: number): TestClaimRow[] {
    return this.db
      .prepare(
        `SELECT * FROM service_test_claims
         WHERE released_at IS NULL AND started_at > ? ORDER BY started_at DESC`,
      )
      .all(now - TEST_CLAIM_TTL_SEC) as TestClaimRow[];
  }

  /** セッションが active な claim を持つか (branch-watch のリマインド抑止に使う)。 */
  hasActiveClaim(sessionId: string, now: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM service_test_claims
         WHERE session_id = ? AND released_at IS NULL AND started_at > ? LIMIT 1`,
      )
      .get(sessionId, now - TEST_CLAIM_TTL_SEC);
    return row !== undefined;
  }
}
