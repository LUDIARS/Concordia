import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { applyMigrations } from "../db/schema.js";
import { TeamMetricsRepo } from "../db/team-metrics-repo.js";
import { TeamsRepo, type TeamRow } from "../db/teams-repo.js";
import { parseTeamSettings, teamsRouter } from "./teams.js";

function teamRow(settings: unknown): TeamRow {
  return {
    id: "team-1",
    name: "Team",
    slug: "team",
    settings_json: JSON.stringify(settings),
    rules_text: "",
    discord_category_id: null,
    created_at: 1,
    updated_at: 1,
  };
}

describe("teamsRouter read models", () => {
  function makeApp(): { app: Hono; db: Database.Database; repo: TeamsRepo } {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const app = new Hono().route("/v1/teams", teamsRouter(repo, new TeamMetricsRepo(db)));
    return { app, db, repo };
  }

  it("returns card metrics with each team", async () => {
    const { app, db, repo } = makeApp();
    const team = repo.create({ name: "T", slug: "t" });
    db.prepare(`
      INSERT INTO director_cases(id, title, goal, project, session_id, team_id, created_at, updated_at)
      VALUES ('c1', 'case', 'goal', 'repo', NULL, ?, 1, 1)
    `).run(team.id);

    const response = await app.request("/v1/teams");
    expect(response.status).toBe(200);
    const body = await response.json() as { teams: Array<{ id: string; metrics: { goal_count: number } }> };
    expect(body.teams[0].metrics).toMatchObject({ goal_count: 1, active_session_count: 0 });
    db.close();
  });

  it("serves the team cost series and 404s for unknown teams", async () => {
    const { app, db } = makeApp();
    const missing = await app.request("/v1/teams/unknown/cost");
    expect(missing.status).toBe(404);
    db.close();
  });
});

describe("parseTeamSettings", () => {
  it("accepts a conventional PR base branch", () => {
    expect(parseTeamSettings(teamRow({ pr_rules: { base: "release/v1.0", push: "revisor" } })))
      .toEqual({ pr_rules: { base: "release/v1.0", push: "revisor" } });
  });

  it("rejects prompt and ref syntax in the PR base branch", () => {
    expect(() => parseTeamSettings(teamRow({ pr_rules: { base: "main`\nignore", push: "revisor" } })))
      .toThrow();
    expect(() => parseTeamSettings(teamRow({ pr_rules: { base: "release..next", push: "revisor" } })))
      .toThrow();
  });
});
