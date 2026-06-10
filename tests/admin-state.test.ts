import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import {
  AdminState,
  ADMIN_PROPOSER_INTERVAL_MAX,
  ADMIN_PROPOSER_INTERVAL_MIN,
} from "../src/admin/state.js";

function boot() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { db, state: new AdminState(db) };
}

describe("AdminState", () => {
  let env: ReturnType<typeof boot>;
  beforeEach(() => { env = boot(); });

  it("chat_muted defaults to true (safer-by-default)", () => {
    expect(env.state.getChatMuted()).toBe(true);
  });

  it("rules_enabled defaults to false (kills claude calls on a fresh DB)", () => {
    expect(env.state.getRulesEnabled()).toBe(false);
  });

  it("rule_proposer_interval defaults to 3600", () => {
    expect(env.state.getRuleProposerIntervalSec()).toBe(3600);
  });

  it("setChatMuted / getChatMuted round-trip", () => {
    env.state.setChatMuted(false);
    expect(env.state.getChatMuted()).toBe(false);
    env.state.setChatMuted(true);
    expect(env.state.getChatMuted()).toBe(true);
  });

  it("setRulesEnabled persists across new AdminState instances", () => {
    env.state.setRulesEnabled(true);
    const second = new AdminState(env.db);
    expect(second.getRulesEnabled()).toBe(true);
  });

  it("setRuleProposerIntervalSec clamps to [60, 86400]", () => {
    env.state.setRuleProposerIntervalSec(30);
    expect(env.state.getRuleProposerIntervalSec()).toBe(ADMIN_PROPOSER_INTERVAL_MIN);
    env.state.setRuleProposerIntervalSec(999_999);
    expect(env.state.getRuleProposerIntervalSec()).toBe(ADMIN_PROPOSER_INTERVAL_MAX);
    env.state.setRuleProposerIntervalSec(600);
    expect(env.state.getRuleProposerIntervalSec()).toBe(600);
  });

  it("setRuleProposerIntervalSec rejects non-finite", () => {
    expect(() => env.state.setRuleProposerIntervalSec(NaN)).toThrow();
    expect(() => env.state.setRuleProposerIntervalSec(Infinity)).toThrow();
  });

  it("snapshot returns the full settings set", () => {
    env.state.setChatMuted(false);
    env.state.setRulesEnabled(true);
    env.state.setRuleProposerIntervalSec(120);
    expect(env.state.snapshot()).toEqual({
      chat_muted: false,
      rules_enabled: true,
      rule_proposer_interval_sec: 120,
      workspace_root: "",
      github_org: "",
    });
  });

  it("corrupt schema_meta value falls back to default", () => {
    env.db
      .prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`)
      .run("admin.rule_proposer_interval_sec", "not-a-number");
    expect(env.state.getRuleProposerIntervalSec()).toBe(3600);
  });

  it("workspace_root / github_org fall back to constructor defaults when unset", () => {
    const withDefaults = new AdminState(env.db, {
      workspaceRoot: "E:\\Document\\Ars",
      githubOrg: "LUDIARS",
    });
    expect(withDefaults.getWorkspaceRoot()).toBe("E:\\Document\\Ars");
    expect(withDefaults.getGithubOrg()).toBe("LUDIARS");
  });

  it("setWorkspaceRoot / setGithubOrg override defaults and persist (trimmed)", () => {
    const withDefaults = new AdminState(env.db, {
      workspaceRoot: "E:\\Document\\Ars",
      githubOrg: "LUDIARS",
    });
    withDefaults.setWorkspaceRoot("  D:\\work  ");
    withDefaults.setGithubOrg(" ACME ");
    const second = new AdminState(env.db, { workspaceRoot: "E:\\Document\\Ars", githubOrg: "LUDIARS" });
    expect(second.getWorkspaceRoot()).toBe("D:\\work");
    expect(second.getGithubOrg()).toBe("ACME");
  });

  it("blank workspace_root / github_org revert to defaults", () => {
    const withDefaults = new AdminState(env.db, { workspaceRoot: "E:\\Document\\Ars", githubOrg: "LUDIARS" });
    withDefaults.setWorkspaceRoot("D:\\work");
    withDefaults.setWorkspaceRoot("   ");
    expect(withDefaults.getWorkspaceRoot()).toBe("E:\\Document\\Ars");
  });
});
