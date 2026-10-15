import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuleVersionsRepo } from "./rule-versions-repo.js";
import { RulesRepo } from "./rules-repo.js";
import { applyMigrations } from "./schema.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function setup() {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const rules = new RulesRepo(db);
  const rule = rules.insert({
    id: "r", description: "d", trigger_type: "tick", tick_sec: 600, event_kind: null, conditions: "[]",
    instructions: "i", target: "chitchat", cooldown_sec: 60, added_by: "human", enabled: false,
    config_version: 2, execution_mode: "patrol", action_config: "{}",
  });
  return { rules, versions: new RuleVersionsRepo(db), rule };
}

describe("RulesRepo revision + RuleVersionsRepo (CC-PATROL-08)", () => {
  it("stores existing rules as legacy-observe by default", () => {
    const { rules } = setup();
    const legacy = rules.insert({
      id: "old", description: null, trigger_type: "tick", tick_sec: 60, event_kind: null, conditions: "[]",
      instructions: "x", target: null, cooldown_sec: 60, added_by: "ai",
    });
    expect(legacy).toMatchObject({ config_version: 1, revision: 1, execution_mode: "legacy-observe", action_config: null });
    expect(rules.list({ execution_mode: "patrol" }).map((r) => r.id)).toEqual(["r"]);
  });

  it("updates only on the expected revision and increments it", () => {
    const { rules } = setup();
    expect(rules.updateWithRevision("r", 2, { instructions: "x" })).toBeNull();
    const next = rules.updateWithRevision("r", 1, { instructions: "x" });
    expect(next).toMatchObject({ revision: 2, instructions: "x" });
    expect(rules.updateWithRevision("r", 1, { instructions: "y" })).toBeNull();
  });

  it("records one snapshot per revision without runtime state", () => {
    const { rules, versions, rule } = setup();
    versions.record(rule, "human", "created", 10);
    versions.record(rule, "human", "dup", 11);
    const next = rules.updateWithRevision("r", 1, { tick_sec: 1200 })!;
    versions.record(next, "human", "edited", 12);
    const rows = versions.list("r");
    expect(rows.map((v) => [v.revision, v.note])).toEqual([[2, "edited"], [1, "created"]]);
    const snap = JSON.parse(versions.find("r", 1)!.snapshot);
    expect(snap.tick_sec).toBe(600);
    expect(snap).not.toHaveProperty("next_due_at");
  });
});
