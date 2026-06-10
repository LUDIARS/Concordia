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
      workspace_roots: [],
      github_org: "",
      reaction_workflow_enabled: false,
      lictor_mode: "auto",
      lictor_dev_path: "",
      lictor_prod_exe: "",
      daily_token_budget: 0,
    });
  });

  it("daily_token_budget: 既定 0 / set-get / 負値は 0 / 非有限は throw", () => {
    expect(env.state.getDailyTokenBudget()).toBe(0);
    env.state.setDailyTokenBudget(500_000);
    expect(env.state.getDailyTokenBudget()).toBe(500_000);
    expect(new AdminState(env.db).getDailyTokenBudget()).toBe(500_000); // 永続
    env.state.setDailyTokenBudget(-10);
    expect(env.state.getDailyTokenBudget()).toBe(0);
    expect(() => env.state.setDailyTokenBudget(Infinity)).toThrow();
  });

  it("workspace roots: multi set / get + primary + dedupe + legacy fallback", () => {
    // 既定 (config) フォールバック。
    const withDefaults = new AdminState(env.db, { workspaceRoots: ["E:\\Document\\Ars", "D:\\Other"] });
    expect(withDefaults.getWorkspaceRoots()).toEqual(["E:\\Document\\Ars", "D:\\Other"]);
    expect(withDefaults.getWorkspaceRoot()).toBe("E:\\Document\\Ars");

    // 複数設定 + 重複/空除去 (正規化パスで dedup)。
    env.state.setWorkspaceRoots(["E:\\A", "  ", "E:/A/", "F:\\B"]);
    expect(env.state.getWorkspaceRoots()).toEqual(["E:\\A", "F:\\B"]);
    expect(env.state.getWorkspaceRoot()).toBe("E:\\A");
    // 別インスタンスでも永続値が読める。
    expect(new AdminState(env.db).getWorkspaceRoots()).toEqual(["E:\\A", "F:\\B"]);

    // 単一 setter は配列キーを [value] に上書き。
    env.state.setWorkspaceRoot("G:\\Solo");
    expect(env.state.getWorkspaceRoots()).toEqual(["G:\\Solo"]);
  });

  it("workspace roots: legacy single key migrates to list", () => {
    // 旧 UI が書いた single key だけがある DB をシミュレート。
    env.db.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`).run(
      "admin.workspace_root",
      "E:\\Legacy",
    );
    expect(new AdminState(env.db).getWorkspaceRoots()).toEqual(["E:\\Legacy"]);
  });

  it("reaction_workflow_enabled defaults from constructor + round-trips", () => {
    expect(env.state.getReactionWorkflowEnabled()).toBe(false);
    const withDefault = new AdminState(env.db, { reactionWorkflowEnabled: true });
    expect(withDefault.getReactionWorkflowEnabled()).toBe(true);
    withDefault.setReactionWorkflowEnabled(false);
    expect(new AdminState(env.db, { reactionWorkflowEnabled: true }).getReactionWorkflowEnabled()).toBe(false);
  });

  it("reaction emoji overrides upsert / delete / persist", () => {
    env.state.setReactionEmojiOverride("🔥", "start-impl");
    env.state.setReactionEmojiOverride("🧊", "memoria-note");
    expect(new AdminState(env.db).getReactionEmojiOverrides()).toEqual({ "🔥": "start-impl", "🧊": "memoria-note" });
    env.state.deleteReactionEmojiOverride("🔥");
    expect(env.state.getReactionEmojiOverrides()).toEqual({ "🧊": "memoria-note" });
  });

  it("lictor mode validates + dev path falls back to default", () => {
    const s = new AdminState(env.db, { lictorDevPath: "E:\\Document\\Ars\\Lictor" });
    expect(s.getLictorMode()).toBe("auto");
    expect(s.getLictorDevPath()).toBe("E:\\Document\\Ars\\Lictor");
    s.setLictorMode("prod");
    s.setLictorProdExe(" C:\\lictor.exe ");
    expect(new AdminState(env.db, { lictorDevPath: "x" }).getLictorMode()).toBe("prod");
    expect(s.getLictorProdExe()).toBe("C:\\lictor.exe");
    expect(() => s.setLictorMode("bogus")).toThrow();
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
