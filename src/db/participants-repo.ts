// participants — 人間入力者の identity レジストリ (最小情報)。
// platform handle ↔ 表示名 ↔ canonical 人物。発言者明示のクロスプラットフォーム
// 名前解決に使う (同名なら別PFでも同一人物とみなす)。schema.ts が table の正本。
//
// ★個人データ規約 (AIFormat §5): 本名/メール等 PII は持たない。platform handle と
//   表示名のみ、loopback ローカル限定。spec/feature/participants.md。

import type { Database } from "better-sqlite3";

const nowSec = (): number => Math.floor(Date.now() / 1000);

export type ParticipantPlatform = "discord" | "slack";

export interface ParticipantRow {
  id: number;
  platform: string;
  platform_user_id: string;
  display_name: string;
  canonical_name: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface ParticipantsRepo {
  /**
   * 入力者を登録/更新し、確定行を返す。canonical_name は表示名を正規化した値で、
   * 別PFで同じ表示名なら同一人物として解決できる。
   */
  upsert(input: { platform: ParticipantPlatform; platform_user_id: string; display_name: string }): ParticipantRow;
  findByPlatformUser(platform: string, platformUserId: string): ParticipantRow | null;
  /** 同一 canonical 人物の全 platform handle (別PF名前解決の逆引き)。 */
  listByCanonical(canonicalName: string): ParticipantRow[];
}

/** 表示名 → canonical キー (前後空白除去 + 小文字化)。表示は display_name を使う。 */
export function canonicalizeName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

export function makeParticipantsRepo(db: Database): ParticipantsRepo {
  return {
    upsert(input) {
      const canonical = canonicalizeName(input.display_name);
      const ts = nowSec();
      db.prepare(
        `INSERT INTO participants (platform, platform_user_id, display_name, canonical_name, first_seen_at, last_seen_at)
         VALUES (@platform, @platform_user_id, @display_name, @canonical_name, @ts, @ts)
         ON CONFLICT(platform, platform_user_id) DO UPDATE SET
           display_name   = excluded.display_name,
           canonical_name = excluded.canonical_name,
           last_seen_at   = excluded.last_seen_at`,
      ).run({
        platform: input.platform,
        platform_user_id: input.platform_user_id,
        display_name: input.display_name,
        canonical_name: canonical,
        ts,
      });
      return this.findByPlatformUser(input.platform, input.platform_user_id)!;
    },
    findByPlatformUser(platform, platformUserId) {
      const row = db
        .prepare("SELECT * FROM participants WHERE platform = ? AND platform_user_id = ?")
        .get(platform, platformUserId) as ParticipantRow | undefined;
      return row ?? null;
    },
    listByCanonical(canonicalName) {
      return db
        .prepare("SELECT * FROM participants WHERE canonical_name = ? ORDER BY platform")
        .all(canonicalizeName(canonicalName)) as ParticipantRow[];
    },
  };
}
