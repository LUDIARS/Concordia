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

  it("separates head-office and subsidiary teams, including repo lookup", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const head = repo.create({ name: "Head", slug: "head" });
    const child = repo.create({ name: "Child", slug: "child", subsidiary_id: "sub-1" });
    repo.setRepos(head.id, ["LUDIARS/shared"]);
    repo.setRepos(child.id, ["LUDIARS/shared"]);

    expect(repo.listForSubsidiary(null).map((team) => team.id)).toEqual([head.id]);
    expect(repo.listForSubsidiary("sub-1").map((team) => team.id)).toEqual([child.id]);
    expect(repo.forRepo("LUDIARS/shared").map((team) => team.id)).toEqual([head.id]);
    expect(repo.forRepo("LUDIARS/shared", "sub-1").map((team) => team.id)).toEqual([child.id]);
    db.close();
  });

  it("moves a repository assignment without leaving the old origin behind", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const team = repo.create({ name: "MoveTeam", slug: "move-team" });
    const second = repo.create({ name: "SecondTeam", slug: "second-team" });
    repo.assignRepoToTeams("LUDIARS/OldName", [team.id, second.id]);

    repo.moveRepoAssignment("ludiars/oldname", "LUDIARS/NewName");

    expect(repo.repos(team.id)).toEqual(["LUDIARS/NewName"]);
    expect(repo.repos(second.id)).toEqual(["LUDIARS/NewName"]);
    expect(repo.forRepo("LUDIARS/OldName")).toEqual([]);
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

  it("suspends and resumes a team, and listActive excludes suspended teams", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new TeamsRepo(db);
    const idle = repo.create({ name: "IdleTeam", slug: "idle-team" });
    const busy = repo.create({ name: "BusyTeam", slug: "busy-team" });

    expect(idle.suspended_at).toBeNull();
    const suspended = repo.setSuspended(idle.id, true);
    expect(suspended?.suspended_at).toEqual(expect.any(Number));
    expect(repo.listActive().map((t) => t.id)).toEqual([busy.id]);
    expect(repo.list().map((t) => t.id).sort()).toEqual([busy.id, idle.id].sort());

    // 冪等: 同じ状態への set は suspended_at を動かさない。
    expect(repo.setSuspended(idle.id, true)?.suspended_at).toBe(suspended?.suspended_at);

    const resumed = repo.setSuspended(idle.id, false);
    expect(resumed?.suspended_at).toBeNull();
    expect(repo.listActive().length).toBe(2);

    expect(repo.setSuspended("team_missing", true)).toBeNull();
    db.close();
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
