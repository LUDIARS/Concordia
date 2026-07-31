/**
 * federation_sites — 連合拠点 (本設計の「子会社」) の登録簿。本社側で保持する。
 *
 * 用語: 既存の subsidiary (外部サーバへの出張所 Bot) とは別概念なので
 * site / federation_* を用いる (spec/plan/multi-site-federation.md 用語衝突の注意)。
 *
 * トークンは secret-box で at-rest 暗号化して保存する (平文保存しない)。
 * 平文トークンは登録 API のレスポンスで一度だけ返し、以後は照合のみ。
 */

import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { SecretBox } from "../shared/secret-box.js";
import { secureValuesMatch } from "../shared/secure-compare.js";

export type FederationSiteStatus = "active" | "revoked";

export interface FederationSiteRow {
  site_id: string;
  name: string | null;
  token_enc: string;
  status: FederationSiteStatus;
  created_at: number;
  revoked_at: number | null;
  last_connected_at: number | null;
  last_seen_at: number | null;
  site_version: string | null;
  villa_pc_id: string | null;
  /** JSON array in SQLite; repo boundary returns decoded guild ids. */
  departments: string[];
}

export interface FederationSitesRepo {
  list(): FederationSiteRow[];
  find(siteId: string): FederationSiteRow | null;
  /** 登録 + トークン発行。戻り値の token は平文 (この一度しか得られない)。既存 ID は throw。 */
  create(input: { siteId: string; name?: string | null }): { row: FederationSiteRow; token: string };
  /** トークン照合 (定数時間)。revoked / 未登録 / 復号失敗は false。 */
  verifyToken(siteId: string, supplied: string): boolean;
  revoke(siteId: string): boolean;
  touchConnected(siteId: string, siteVersion: string | null): void;
  touchSeen(siteId: string): void;
  setDepartments(siteId: string, departments: readonly string[]): boolean;
  setVillaPcId(siteId: string, villaPcId: string | null): boolean;
}

export function makeFederationSitesRepo(
  db: Database.Database,
  secretBox: SecretBox,
  nowSec: () => number = () => Math.floor(Date.now() / 1000),
): FederationSitesRepo {
  // メソッド間の呼び出しは this を経由しない (分割代入で渡しても壊れないように)。
  const decodeRow = (row: Omit<FederationSiteRow, "departments"> & { departments: string }): FederationSiteRow => ({
    ...row,
    departments: decodeDepartments(row.departments),
  });
  const findRow = (siteId: string): FederationSiteRow | null => {
    const row = db.prepare("SELECT * FROM federation_sites WHERE site_id = ?")
      .get(siteId) as (Omit<FederationSiteRow, "departments"> & { departments: string }) | undefined;
    return row ? decodeRow(row) : null;
  };

  return {
    list() {
      return (db.prepare(
        "SELECT * FROM federation_sites ORDER BY created_at, site_id",
      ).all() as Array<Omit<FederationSiteRow, "departments"> & { departments: string }>).map(decodeRow);
    },
    find(siteId) {
      return findRow(siteId);
    },
    create(input) {
      const token = randomBytes(32).toString("base64url");
      db.prepare(
        `INSERT INTO federation_sites (site_id, name, token_enc, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
      ).run(input.siteId, input.name ?? null, secretBox.encrypt(token), nowSec());
      return { row: findRow(input.siteId) as FederationSiteRow, token };
    },
    verifyToken(siteId, supplied) {
      const row = findRow(siteId);
      if (!row || row.status !== "active") return false;
      let expected: string;
      try {
        expected = secretBox.decrypt(row.token_enc);
      } catch {
        return false;
      }
      return secureValuesMatch(expected, supplied);
    },
    revoke(siteId) {
      const result = db.prepare(
        "UPDATE federation_sites SET status = 'revoked', revoked_at = ? WHERE site_id = ? AND status = 'active'",
      ).run(nowSec(), siteId);
      return result.changes > 0;
    },
    touchConnected(siteId, siteVersion) {
      const now = nowSec();
      db.prepare(
        "UPDATE federation_sites SET last_connected_at = ?, last_seen_at = ?, site_version = ? WHERE site_id = ?",
      ).run(now, now, siteVersion, siteId);
    },
    touchSeen(siteId) {
      db.prepare("UPDATE federation_sites SET last_seen_at = ? WHERE site_id = ?")
        .run(nowSec(), siteId);
    },
    setDepartments(siteId, departments) {
      const result = db.prepare("UPDATE federation_sites SET departments = ? WHERE site_id = ?")
        .run(JSON.stringify([...new Set(departments)]), siteId);
      return result.changes > 0;
    },
    setVillaPcId(siteId, villaPcId) {
      return db.prepare("UPDATE federation_sites SET villa_pc_id = ? WHERE site_id = ?")
        .run(villaPcId, siteId).changes > 0;
    },
  };
}

function decodeDepartments(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === "string"))] : [];
  } catch {
    return [];
  }
}
