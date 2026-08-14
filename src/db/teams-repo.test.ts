import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { TeamsRepo } from "./teams-repo.js";

describe("TeamsRepo", () => {
  it("stores typed team ownership and updates the slug", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const team = repo.create({
      name: "MakaiNui",
      slug: "makai-nui",
      settings: { visibility: "private" },
    });
    repo.setRepos(team.id, ["LUDIARS/MakaiNui"]);

    expect(repo.repos(team.id)).toEqual(["LUDIARS/MakaiNui"]);
    expect(repo.patch(team.id, { slug: "makai-nui-unity" })?.slug).toBe("makai-nui-unity");
    db.close();
  });

  it("resolves a team surface channel_id and returns null when unprovisioned", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "SurfaceTeam", slug: "surface-team" });

    expect(repo.surfaceChannelId(team.id, "direction")).toBeNull();

    db.prepare("INSERT INTO team_surfaces(team_id, surface, channel_id) VALUES (?, 'direction', 'chan-1')").run(team.id);
    expect(repo.surfaceChannelId(team.id, "direction")).toBe("chan-1");
  });

  it("claims an audit post dedupe key exactly once", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "DedupeTeam", slug: "dedupe-team" });

    expect(repo.claimAuditPost("created:team-1", team.id)).toBe(true);
    expect(repo.claimAuditPost("created:team-1", team.id)).toBe(false);
    expect(repo.claimAuditPost("changed:team-1:2", team.id)).toBe(true);
  });
});
