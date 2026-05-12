import type Database from "better-sqlite3";

export interface SkillSnapshotRow {
  id: number;
  repo_origin: string | null;
  repo_path: string;
  skill_name: string;
  ts: number;
  content_hash: string;
  content: string;
  size_bytes: number;
  line_count: number;
  section_count: number;
  source: string;
  poison_score: number;
  poison_reasons: string;
  growth_score: number;
  growth_notes: string;
}

export class SkillsRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: {
    repo_origin: string | null;
    repo_path: string;
    skill_name: string;
    content: string;
    content_hash: string;
    size_bytes: number;
    line_count: number;
    section_count: number;
    source: string;
    poison_score: number;
    poison_reasons: string[];
    growth_score: number;
    growth_notes: string[];
  }): SkillSnapshotRow {
    const ts = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `INSERT INTO skill_snapshots(
          repo_origin, repo_path, skill_name, ts, content_hash, content,
          size_bytes, line_count, section_count, source,
          poison_score, poison_reasons, growth_score, growth_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.repo_origin,
        input.repo_path,
        input.skill_name,
        ts,
        input.content_hash,
        input.content,
        input.size_bytes,
        input.line_count,
        input.section_count,
        input.source,
        input.poison_score,
        JSON.stringify(input.poison_reasons),
        input.growth_score,
        JSON.stringify(input.growth_notes),
      );
    return this.find(Number(r.lastInsertRowid))!;
  }

  find(id: number): SkillSnapshotRow | null {
    return (
      (this.db.prepare(`SELECT * FROM skill_snapshots WHERE id = ?`).get(id) as SkillSnapshotRow | undefined) ??
      null
    );
  }

  /** 直近 snapshot. 同じ (repo_path, skill_name) で最新のもの. */
  latest(repoPath: string, skillName: string): SkillSnapshotRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM skill_snapshots WHERE repo_path = ? AND skill_name = ?
           ORDER BY ts DESC LIMIT 1`,
        )
        .get(repoPath, skillName) as SkillSnapshotRow | undefined) ?? null
    );
  }

  history(repoPath: string, skillName: string, limit = 50): SkillSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT * FROM skill_snapshots WHERE repo_path = ? AND skill_name = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(repoPath, skillName, limit) as SkillSnapshotRow[];
  }

  /** 各 (repo_path, skill_name) の最新 snapshot 一覧 */
  listLatest(): SkillSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT s.* FROM skill_snapshots s
         INNER JOIN (
           SELECT repo_path, skill_name, MAX(ts) AS max_ts
           FROM skill_snapshots GROUP BY repo_path, skill_name
         ) latest
           ON s.repo_path = latest.repo_path
          AND s.skill_name = latest.skill_name
          AND s.ts = latest.max_ts
         ORDER BY s.ts DESC`,
      )
      .all() as SkillSnapshotRow[];
  }
}
