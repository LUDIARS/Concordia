import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { WalksRepo, walkComboKey } from "./walks-repo.js";

function makeRepo(): WalksRepo {
  const db = new Database(":memory:");
  applyMigrations(db);
  return new WalksRepo(db);
}

describe("WalksRepo", () => {
  it("inserts a walk and records the combo key", () => {
    const repo = makeRepo();
    const row = repo.insert({
      team_id: "team-1",
      subsidiary_id: null,
      repo_a: "Pictor",
      repo_b: "Ergo",
      material_a: "Pictor spec/feature/a.md",
      material_b: "Ergo spec/feature/b.md",
      combo_key: walkComboKey("Pictor", "Ergo"),
      run_id: null,
    });
    expect(row.id).toMatch(/^walk_/);
    repo.setRunId(row.id, "run-9");
    expect(repo.recentComboKeys(60_000).has("ergo|pictor")).toBe(true);
  });

  it("excludes combos older than the window", () => {
    const repo = makeRepo();
    repo.insert({
      team_id: null, subsidiary_id: null,
      repo_a: "A", repo_b: "B",
      material_a: "a", material_b: "b",
      combo_key: walkComboKey("A", "B"), run_id: null,
    });
    expect(repo.recentComboKeys(60_000, Date.now() + 120_000).size).toBe(0);
  });

  it("does not suppress a combo whose delegation never launched", () => {
    const repo = makeRepo();
    repo.insert({
      team_id: null, subsidiary_id: null,
      repo_a: "A", repo_b: "B",
      material_a: "a", material_b: "b",
      combo_key: walkComboKey("A", "B"), run_id: null,
    });
    expect(repo.recentComboKeys(60_000).size).toBe(0);
  });

  it("normalizes combo keys order- and case-insensitively", () => {
    expect(walkComboKey("Pictor", "ergo")).toBe(walkComboKey("Ergo", "pictor"));
  });
});
