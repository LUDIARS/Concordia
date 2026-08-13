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
});
