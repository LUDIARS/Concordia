import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { makeTestDb } from "./helpers/db.js";
import { AdminState } from "../src/admin/state.js";
import { SecretBox, isEncrypted } from "../src/shared/secret-box.js";
import { DEFAULT_MAIN_PUSH_ALLOWLIST } from "../src/harness/main-push-allowlist.js";
import { WORKFLOW_KEYS } from "../src/workflow/keys.js";

function boot() {
  const db = makeTestDb();
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

  it("snapshot returns the full settings set", () => {
    env.state.setChatMuted(false);
    env.state.setRulesEnabled(true);
    expect(env.state.snapshot()).toEqual({
      chat_muted: false,
      rules_enabled: true,
      workspace_root: "",
      workspace_roots: [],
      github_org: "",
      reaction_workflow_enabled: false,
      cc_workflow_enabled: false,
      revisor_auto_submit_enabled: true,
      lictor_mode: "auto",
      lictor_dev_path: "",
      lictor_prod_exe: "",
      daily_token_budget: 0,
      delegation_max_concurrency: 4,
      harness_strong_impl_models: ["fable", "sol-ultra"],
      mention_user_id: null,
      // main 直 push 許可リスト (PartnerOrg 例外)。 設定 / env 未指定なので既定シード。
      harness_main_push_allowlist: [...DEFAULT_MAIN_PUSH_ALLOWLIST],
      cron_job_overrides: {},
      delegation_watchdog_enabled: true,
      delegation_watchdog_idle_sec: 1800,
      delegation_watchdog_max_nudges: 3,
      delegation_watchdog_unstarted_sec: 300,
      reaper_session_end_grace_sec: 300,
      // ワークフロー個別有効化フラグ。 既定は全て有効 (spec W1)。
      // 一覧を手で写すと key を足すたびにここが落ちるだけなので、 正本から導く。
      // 検証したいのは「全 key が既定で有効」であって、 key の綴りではない。
      workflows: Object.fromEntries(
        WORKFLOW_KEYS.map((key) => [key, { enabled: true, source: "default" }]),
      ),
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

  it("migrates a renamed cron job override without losing a custom template", () => {
    env.state.setCronJobOverride("ludiars-review-daily", "custom-review-template");

    env.state.migrateCronJobOverride(
      "ludiars-review-daily",
      "ludiars-review-weekly",
      "ludiars-review-daily",
      "ludiars-review-weekly",
    );

    expect(env.state.getCronJobOverride("ludiars-review-daily")).toBeNull();
    expect(env.state.getCronJobOverride("ludiars-review-weekly")).toBe("custom-review-template");
  });

  it("replaces a retired cron default while migrating its override", () => {
    env.state.setCronJobOverride("ludiars-review-daily", "ludiars-review-daily");

    env.state.migrateCronJobOverride(
      "ludiars-review-daily",
      "ludiars-review-weekly",
      "ludiars-review-daily",
      "ludiars-review-weekly",
    );

    expect(env.state.getCronJobOverride("ludiars-review-daily")).toBeNull();
    expect(env.state.getCronJobOverride("ludiars-review-weekly")).toBe("ludiars-review-weekly");
  });

  it("keeps an existing override for the renamed cron job", () => {
    env.state.setCronJobOverride("ludiars-review-daily", "stale-custom-template");
    env.state.setCronJobOverride("ludiars-review-weekly", "current-custom-template");

    env.state.migrateCronJobOverride(
      "ludiars-review-daily",
      "ludiars-review-weekly",
      "ludiars-review-daily",
      "ludiars-review-weekly",
    );

    expect(env.state.getCronJobOverride("ludiars-review-daily")).toBeNull();
    expect(env.state.getCronJobOverride("ludiars-review-weekly")).toBe("current-custom-template");
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

  // 発火ユーザの allowlist は AdminState から撤去済み (社員名簿 staff_members が正本)。
  // 権限判定の回帰テストは tests/staff-api.test.ts と src/staff/roles.test.ts が担う。

  it("cc_workflow_enabled defaults from constructor + round-trips", () => {
    expect(env.state.getCcWorkflowEnabled()).toBe(false);
    const withDefault = new AdminState(env.db, { ccWorkflowEnabled: true });
    expect(withDefault.getCcWorkflowEnabled()).toBe(true);
    withDefault.setCcWorkflowEnabled(false);
    expect(new AdminState(env.db, { ccWorkflowEnabled: true }).getCcWorkflowEnabled()).toBe(false);
  });

  // 既定 ON。 レビュー発火が黙って無くなる状態を作らないため、 明示 OFF だけが止める。
  it("revisor_auto_submit_enabled defaults to on + round-trips", () => {
    expect(env.state.getRevisorAutoSubmitEnabled()).toBe(true);
    env.state.setRevisorAutoSubmitEnabled(false);
    expect(new AdminState(env.db).getRevisorAutoSubmitEnabled()).toBe(false);
    env.state.setRevisorAutoSubmitEnabled(true);
    expect(new AdminState(env.db, { revisorAutoSubmitEnabled: false }).getRevisorAutoSubmitEnabled()).toBe(true);
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
      .run("admin.daily_token_budget", "not-a-number");
    expect(env.state.getDailyTokenBudget()).toBe(0);
  });

  it("encrypts persisted user settings and migrates legacy plaintext", () => {
    const box = new SecretBox(randomBytes(32));
    const encrypted = new AdminState(env.db, {}, box);
    encrypted.setDailyTokenBudget(50_000);
    const raw = env.db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get("admin.daily_token_budget") as { value: string };
    expect(isEncrypted(raw.value)).toBe(true);
    expect(raw.value).not.toContain("50000");
    expect(new AdminState(env.db, {}, box).getDailyTokenBudget()).toBe(50_000);

    env.db.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`).run("admin.reaper_session_end_grace_sec", "180");
    expect(encrypted.getReaperSessionEndGraceSec()).toBe(180);
    const migrated = env.db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get("admin.reaper_session_end_grace_sec") as { value: string };
    expect(isEncrypted(migrated.value)).toBe(true);
  });

  it("session-end reaper grace defaults, persists, and rejects invalid values", () => {
    expect(env.state.getReaperSessionEndGraceSec()).toBe(300);
    expect(new AdminState(env.db, { reaperSessionEndGraceSec: 240 }).getReaperSessionEndGraceSec()).toBe(240);
    env.state.setReaperSessionEndGraceSec(180);
    expect(new AdminState(env.db).getReaperSessionEndGraceSec()).toBe(180);
    expect(() => env.state.setReaperSessionEndGraceSec(0)).toThrow();
  });

  it("delegation watchdog unstarted threshold persists and rejects invalid values", () => {
    expect(env.state.getDelegationWatchdogUnstartedSec()).toBe(300);
    env.state.setDelegationWatchdogUnstartedSec(120);
    expect(new AdminState(env.db).getDelegationWatchdogUnstartedSec()).toBe(120);
    expect(() => env.state.setDelegationWatchdogUnstartedSec(0)).toThrow();
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
