/**
 * 依頼者メモ (requester_profiles) の repository。 投稿ユーザーごとのローカルな前提を
 * 会社 × platform × user で 1 行持つ。 値をログへ出さない (CC-DLG-INV-04)。
 *
 * @implements spec/feature/dialogue-context.md §4 / §7
 * @implements SPEC-DLG-PROFILES
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type RequesterPlatform = "discord" | "slack";

export interface RequesterProfileRow {
  id: string;
  subsidiary_id: string | null;
  platform: RequesterPlatform;
  platform_user_id: string;
  display_name: string;
  skill_level: string;
  /** 役職 (tech-consultation.md §3)。 技術レベルと並ぶ事前ヒアリングの既定値。 */
  role_title: string;
  activities: string;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface RequesterIdentity {
  subsidiary_id: string | null;
  platform: RequesterPlatform;
  platform_user_id: string;
}

export interface RequesterProfileFields {
  display_name?: string;
  skill_level?: string;
  role_title?: string;
  activities?: string;
  notes?: string;
}

export class RequesterProfilesRepo {
  constructor(private readonly db: Database.Database) {}

  list(subsidiaryId: string | null): RequesterProfileRow[] {
    return this.db.prepare(
      "SELECT * FROM requester_profiles WHERE subsidiary_id IS ? ORDER BY display_name, platform_user_id",
    ).all(subsidiaryId) as RequesterProfileRow[];
  }

  find(identity: RequesterIdentity): RequesterProfileRow | null {
    return (this.db.prepare(`
      SELECT * FROM requester_profiles WHERE subsidiary_id IS ? AND platform = ? AND platform_user_id = ?
    `).get(identity.subsidiary_id, identity.platform, identity.platform_user_id) as RequesterProfileRow | undefined) ?? null;
  }

  findById(id: string): RequesterProfileRow | null {
    return (this.db.prepare("SELECT * FROM requester_profiles WHERE id = ?").get(id) as RequesterProfileRow | undefined) ?? null;
  }

  /** 無ければ空のメモ行を作る。 既にあれば表示名だけ空欄のときに埋める (人の編集を上書きしない)。 */
  ensure(identity: RequesterIdentity, displayName: string, now: number = Date.now()): RequesterProfileRow {
    const existing = this.find(identity);
    if (existing) {
      if (!existing.display_name && displayName) {
        this.db.prepare("UPDATE requester_profiles SET display_name = ?, updated_at = ? WHERE id = ?")
          .run(displayName, now, existing.id);
        return this.findById(existing.id)!;
      }
      return existing;
    }
    return this.upsert(identity, { display_name: displayName }, now);
  }

  upsert(identity: RequesterIdentity, fields: RequesterProfileFields, now: number = Date.now()): RequesterProfileRow {
    const existing = this.find(identity);
    if (!existing) {
      const id = `rp_${randomUUID().replace(/-/g, "")}`;
      this.db.prepare(`
        INSERT INTO requester_profiles(id, subsidiary_id, platform, platform_user_id, display_name, skill_level,
          role_title, activities, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, identity.subsidiary_id, identity.platform, identity.platform_user_id,
        fields.display_name ?? "", fields.skill_level ?? "", fields.role_title ?? "", fields.activities ?? "",
        fields.notes ?? "", now, now,
      );
      return this.findById(id)!;
    }
    this.db.prepare(`
      UPDATE requester_profiles
      SET display_name = ?, skill_level = ?, role_title = ?, activities = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      fields.display_name ?? existing.display_name,
      fields.skill_level ?? existing.skill_level,
      fields.role_title ?? existing.role_title,
      fields.activities ?? existing.activities,
      fields.notes ?? existing.notes,
      now,
      existing.id,
    );
    return this.findById(existing.id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM requester_profiles WHERE id = ?").run(id).changes > 0;
  }
}
