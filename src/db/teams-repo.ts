import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  settings_json: string;
  rules_text: string;
  discord_category_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface TeamWriteInput {
  name: string;
  slug: string;
  settings?: unknown;
  rules_text?: string;
}

export class TeamsRepo {
  constructor(private readonly db: Database.Database) {}

  list(): TeamRow[] {
    return this.db.prepare("SELECT * FROM teams ORDER BY name").all() as TeamRow[];
  }

  find(id: string): TeamRow | null {
    return (this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as TeamRow | undefined) ?? null;
  }

  findByIdOrSlug(value: string): TeamRow | null {
    return (this.db.prepare("SELECT * FROM teams WHERE id = ? OR slug = ? LIMIT 1").get(value, value) as TeamRow | undefined) ?? null;
  }

  create(input: TeamWriteInput): TeamRow {
    const now = Date.now();
    const id = `team_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO teams(id, name, slug, settings_json, rules_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.slug,
      JSON.stringify(input.settings ?? {}),
      input.rules_text ?? "",
      now,
      now,
    );
    return this.find(id)!;
  }

  patch(id: string, input: Partial<TeamWriteInput>): TeamRow | null {
    const row = this.find(id);
    if (!row) return null;
    this.db.prepare(`
      UPDATE teams
      SET name = ?, slug = ?, settings_json = ?, rules_text = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? row.name,
      input.slug ?? row.slug,
      input.settings === undefined ? row.settings_json : JSON.stringify(input.settings),
      input.rules_text ?? row.rules_text,
      Date.now(),
      id,
    );
    return this.find(id);
  }

  setRepos(id: string, repos: readonly string[]): void {
    const update = this.db.transaction(() => {
      this.db.prepare("DELETE FROM team_repos WHERE team_id = ?").run(id);
      const insert = this.db.prepare("INSERT INTO team_repos(team_id, repo_origin) VALUES (?, ?)");
      for (const repo of repos) insert.run(id, repo);
    });
    update();
  }

  repos(id: string): string[] {
    return (this.db.prepare(`
      SELECT repo_origin FROM team_repos WHERE team_id = ? ORDER BY repo_origin
    `).all(id) as Array<{ repo_origin: string }>).map((row) => row.repo_origin);
  }

  forRepo(repoOrigin: string): TeamRow[] {
    return this.db.prepare(`
      SELECT teams.*
      FROM teams
      JOIN team_repos ON team_repos.team_id = teams.id
      WHERE lower(team_repos.repo_origin) = lower(?)
      ORDER BY teams.name
    `).all(repoOrigin) as TeamRow[];
  }

  surfaceChannelId(teamId: string, surface: string): string | null {
    const row = this.db.prepare(
      "SELECT channel_id FROM team_surfaces WHERE team_id = ? AND surface = ?",
    ).get(teamId, surface) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  /** dedupe_key を初回だけ記録する。true = 初回 (投稿してよい)、false = 既出 (skip)。 */
  claimAuditPost(dedupeKey: string, teamId: string): boolean {
    const result = this.db.prepare(
      "INSERT INTO team_audit_posts(dedupe_key, team_id, posted_at) VALUES (?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING",
    ).run(dedupeKey, teamId, Date.now());
    return result.changes > 0;
  }
}
