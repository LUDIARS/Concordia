import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface TeamRow {
  id: string;
  name: string;
  slug: string;
  settings_json: string;
  rules_text: string;
  discord_category_id: string | null;
  /**
   * 一時停止した時刻 (epoch-ms)。 NULL = 稼働中。
   * 一時停止中のチームは定時 fanout (朝礼 / 定例 / issue scout / タスク整理) の
   * 対象から外れる。 手動の spawn / チーム面への投稿は止めない (アーカイブではない)。
   */
  suspended_at: number | null;
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

  /**
   * 一時停止中でないチームだけ。 定時 fanout の対象列挙に使う。
   * @implements spec/feature/teams.md §4.5
   */
  listActive(): TeamRow[] {
    return this.db.prepare("SELECT * FROM teams WHERE suspended_at IS NULL ORDER BY name").all() as TeamRow[];
  }

  /**
   * 一時停止 / 再開。 既に同じ状態なら何もしない (冪等)。
   * 戻り値は更新後の行。 チームが無ければ null。
   */
  setSuspended(id: string, suspended: boolean): TeamRow | null {
    const row = this.find(id);
    if (!row) return null;
    const alreadySuspended = row.suspended_at !== null;
    if (alreadySuspended === suspended) return row;
    const now = Date.now();
    this.db.prepare("UPDATE teams SET suspended_at = ?, updated_at = ? WHERE id = ?")
      .run(suspended ? now : null, now, id);
    return this.find(id);
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

  /**
   * Discord のカテゴリ id からチームを引く。 spawn がチャンネル起点でチームを
   * 決めるときの入口 (spec/feature/teams.md §2)。
   */
  findByDiscordCategoryId(categoryId: string): TeamRow | null {
    if (!categoryId) return null;
    return (this.db.prepare(
      "SELECT * FROM teams WHERE discord_category_id = ? LIMIT 1",
    ).get(categoryId) as TeamRow | undefined) ?? null;
  }

  /**
   * チーム面 (team_surfaces) の channel_id からチームを引く。 カテゴリ配下でなく
   * 面そのもので spawn された場合に使う。
   */
  findBySurfaceChannelId(channelId: string): TeamRow | null {
    if (!channelId) return null;
    return (this.db.prepare(`
      SELECT teams.*
      FROM teams
      JOIN team_surfaces ON team_surfaces.team_id = teams.id
      WHERE team_surfaces.channel_id = ?
      LIMIT 1
    `).get(channelId) as TeamRow | undefined) ?? null;
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
