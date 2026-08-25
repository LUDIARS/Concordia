import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { TeamsRepo } from "../db/teams-repo.js";
import { TEAM_CARD_SURFACE, resolveTeamCardChannel } from "./team-card-routing.js";

function makeDb() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return db;
}

describe("resolveTeamCardChannel", () => {
  it("routes each card kind to its provisioned team surface channel", () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Alpha", slug: "alpha" });
    const insert = db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, ?, ?)");
    insert.run(team.id, "目標", "chan-goal");
    insert.run(team.id, "direction", "chan-direction");
    insert.run(team.id, "コスト", "chan-cost");
    insert.run(team.id, "タスクボード", "chan-board");

    expect(resolveTeamCardChannel(repo, team.id, "director-plan")).toBe("chan-goal");
    expect(resolveTeamCardChannel(repo, team.id, "decision-log")).toBe("chan-direction");
    expect(resolveTeamCardChannel(repo, team.id, "question")).toBe("chan-direction");
    expect(resolveTeamCardChannel(repo, team.id, "cost-daily")).toBe("chan-cost");
    expect(resolveTeamCardChannel(repo, team.id, "task-kanban")).toBe("chan-board");
    expect(resolveTeamCardChannel(repo, team.id, "issue-hypothesis")).toBe("chan-board");
    db.close();
  });

  it("falls back (null) when the session has no team", () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);

    expect(resolveTeamCardChannel(repo, null, "question")).toBeNull();
    expect(resolveTeamCardChannel(repo, undefined, "director-plan")).toBeNull();
    db.close();
  });

  it("falls back (null) when the surface is not provisioned for the team", () => {
    const db = makeDb();
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "Beta", slug: "beta" });
    // 目標だけプロビジョニング済み — direction を要するカードはフォールバックする。
    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, '目標', 'chan-goal')").run(team.id);

    expect(resolveTeamCardChannel(repo, team.id, "decision-log")).toBeNull();
    expect(resolveTeamCardChannel(repo, team.id, "question")).toBeNull();
    expect(resolveTeamCardChannel(repo, team.id, "director-plan")).toBe("chan-goal");
    db.close();
  });

  it("keeps the surface mapping aligned with the provisioned surface names", () => {
    // team-provision.ts の SURFACES (目標/タスクボード/コスト/direction/セッション/タスク)
    // に存在しない surface 名へ張ると、 全カードが黙ってフォールバックし続ける。
    const provisioned = new Set(["目標", "タスクボード", "コスト", "direction", "セッション", "タスク"]);
    for (const surface of Object.values(TEAM_CARD_SURFACE)) {
      expect(provisioned.has(surface)).toBe(true);
    }
  });
});
