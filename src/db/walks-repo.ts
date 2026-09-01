import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * 散歩セッション (curiosity walk) の発火記録 (spec/feature/curiosity-walk.md §4)。
 *
 * 素材の組み合わせ種類 (combo_key = repo ペアの正規化) を記録し、直近に出した種類を
 * 避けるサンプリングに使う。反応の重み学習の土台でもある (walk_id を投稿へ埋める)。
 */

export interface WalkRow {
  id: string;
  team_id: string | null;
  subsidiary_id: string | null;
  repo_a: string;
  repo_b: string;
  material_a: string;
  material_b: string;
  combo_key: string;
  run_id: string | null;
  created_at: number;
}

export function walkComboKey(repoA: string, repoB: string): string {
  return [repoA, repoB].map((r) => r.toLowerCase()).sort().join("|");
}

export class WalksRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: Omit<WalkRow, "id" | "created_at"> & { id?: string }): WalkRow {
    const row: WalkRow = {
      id: input.id ?? `walk_${randomUUID().replace(/-/g, "")}`,
      team_id: input.team_id,
      subsidiary_id: input.subsidiary_id,
      repo_a: input.repo_a,
      repo_b: input.repo_b,
      material_a: input.material_a,
      material_b: input.material_b,
      combo_key: input.combo_key,
      run_id: input.run_id,
      created_at: Date.now(),
    };
    this.db.prepare(`
      INSERT INTO curiosity_walks(id, team_id, subsidiary_id, repo_a, repo_b, material_a, material_b, combo_key, run_id, created_at)
      VALUES (@id, @team_id, @subsidiary_id, @repo_a, @repo_b, @material_a, @material_b, @combo_key, @run_id, @created_at)
    `).run(row);
    return row;
  }

  setRunId(id: string, runId: string): void {
    this.db.prepare("UPDATE curiosity_walks SET run_id = ? WHERE id = ?").run(runId, id);
  }

  /** 直近 sinceMs 以内に起動できた組み合わせ種類 (重複を避けるサンプリング用)。 */
  recentComboKeys(sinceMs: number, now = Date.now()): Set<string> {
    const rows = this.db.prepare(
      "SELECT DISTINCT combo_key FROM curiosity_walks WHERE run_id IS NOT NULL AND created_at >= ?",
    ).all(now - sinceMs) as Array<{ combo_key: string }>;
    return new Set(rows.map((r) => r.combo_key));
  }
}
