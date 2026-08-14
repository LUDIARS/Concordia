/**
 * teams-webui のチームフィルタ read model (sessions / harness_rules) の回帰テスト。
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { HarnessRulesRepo } from "./harness-rules-repo.js";
import { SessionsRepo } from "./sessions-repo.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

function seedSession(repo: SessionsRepo, id: string, teamId: string | null): void {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "E:/repo",
    repo_origin: "LUDIARS/repo",
    branch: "feat/x",
    host: "host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
    team_id: teamId,
  });
}

describe("SessionsRepo.listSessions team filter", () => {
  it("returns only the sessions owned by the team", () => {
    const db = makeDb();
    const repo = new SessionsRepo(db);
    seedSession(repo, "s-team", "team-1");
    seedSession(repo, "s-other", "team-2");
    seedSession(repo, "s-none", null);

    expect(repo.listSessions({ team_id: "team-1" }).map((s) => s.id)).toEqual(["s-team"]);
    expect(repo.listSessions({}).length).toBe(3);
    db.close();
  });
});

describe("HarnessRulesRepo.list team scope", () => {
  it("merges global rules with the team's own rules", () => {
    const db = makeDb();
    const repo = new HarnessRulesRepo(db);
    const global = repo.create({ kind: "block", description: "global rule" });
    const mine = repo.create({ kind: "allow", description: "team rule", team_id: "team-1" });
    repo.create({ kind: "block", description: "other team rule", team_id: "team-2" });

    const scoped = repo.list({ includeDisabled: true, teamId: "team-1" });
    expect(scoped.map((rule) => rule.id).sort()).toEqual([global.id, mine.id].sort());
    db.close();
  });

  it("still lists everything when no team is given", () => {
    const db = makeDb();
    const repo = new HarnessRulesRepo(db);
    repo.create({ kind: "block", description: "global rule" });
    repo.create({ kind: "allow", description: "team rule", team_id: "team-1" });

    expect(repo.list({ includeDisabled: true }).length).toBe(2);
    db.close();
  });
});
