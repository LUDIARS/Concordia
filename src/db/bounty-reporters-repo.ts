/**
 * バグ報告の報告者・受取人 (bounty_reporters) の repository。 保存と照会だけを持つ。
 * 誰が受取人になるか・公開名の書式は src/bounty/reporter.ts が決める。
 *
 * 依頼者メモ (requester_profiles) と同じ識別 (会社・プラットフォーム・ユーザー id) だが、 行は
 * bug-bounty が所有する (spec/feature/bug-bounty.md §4)。
 *
 * @implements SPEC-BOUNTY-REPORTER
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface BountyReporterRow {
  id: string;
  /** 所属会社。 本社は null。 */
  subsidiary_id: string | null;
  platform: string;
  platform_user_id: string;
  /** 報告者が自分で決めた公開名。 未設定 (匿名) は null。 */
  public_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface BountyReporterKey {
  subsidiary_id: string | null;
  platform: string;
  platform_user_id: string;
}

export class BountyReportersRepo {
  constructor(private readonly db: Database.Database) {}

  find(id: string): BountyReporterRow | null {
    return (this.db.prepare("SELECT * FROM bounty_reporters WHERE id = ?").get(id) as BountyReporterRow | undefined) ?? null;
  }

  findByKey(key: BountyReporterKey): BountyReporterRow | null {
    return (this.db.prepare(`
      SELECT * FROM bounty_reporters
      WHERE COALESCE(subsidiary_id, '') = ? AND platform = ? AND platform_user_id = ?
    `).get(key.subsidiary_id ?? "", key.platform, key.platform_user_id) as BountyReporterRow | undefined) ?? null;
  }

  /** 同じ人は 1 行。 既にあればその行を返し、 公開名を変えない。 */
  findOrCreate(key: BountyReporterKey, now: number = Date.now()): BountyReporterRow {
    return this.db.transaction((): BountyReporterRow => {
      const existing = this.findByKey(key);
      if (existing) return existing;
      const id = `bp_${randomUUID().replace(/-/g, "")}`;
      this.db.prepare(`
        INSERT INTO bounty_reporters(id, subsidiary_id, platform, platform_user_id, public_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(id, key.subsidiary_id, key.platform, key.platform_user_id, now, now);
      return this.find(id)!;
    })();
  }

  /** 公開名を変える (null で匿名へ戻す)。 行が無ければ作る。 */
  setPublicName(key: BountyReporterKey, publicName: string | null, now: number = Date.now()): BountyReporterRow {
    return this.db.transaction((): BountyReporterRow => {
      const reporter = this.findOrCreate(key, now);
      this.db.prepare("UPDATE bounty_reporters SET public_name = ?, updated_at = ? WHERE id = ?")
        .run(publicName, now, reporter.id);
      return this.find(reporter.id)!;
    })();
  }
}
