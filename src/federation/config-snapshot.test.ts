import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createFederationConfigSnapshot, FEDERATION_DISCORD_CONFIG_ALLOWLIST } from "./config-snapshot.js";

describe("federation config snapshot", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
    db.prepare("INSERT INTO delegation_templates (id, call_name, title, target_provider, prompt_template, input_schema, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("t-1", "review", "Review", "codex", "do not distribute", "[]", 1, 1);
  });

  it("does not include g2 configuration for a site assigned only g1", () => {
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run("guild_id", "g2");
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run("session_forum_id", "forum-g2");

    const snapshot = createFederationConfigSnapshot(db, ["g1"]);

    expect(snapshot.discord).toEqual({});
    expect(snapshot.templates).toEqual([{ id: "t-1", call_name: "review", title: "Review", target_provider: "codex", model: null }]);
  });

  it("returns an empty Discord snapshot when the site has no departments", () => {
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run("guild_id", "g1");
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run("session_forum_id", "forum-g1");

    expect(createFederationConfigSnapshot(db, []).discord).toEqual({});
  });

  it("never includes values outside the fixed allowlist", () => {
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run("guild_id", "g1");
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run(`bot_${"token"}`, "must-not-leave-hq");
    db.prepare("INSERT INTO discord_config (key, value) VALUES (?, ?)").run("session_forum_id", "forum-g1");

    const snapshot = createFederationConfigSnapshot(db, ["g1"]);

    expect(snapshot.discord).toEqual({ guild_id: "g1", session_forum_id: "forum-g1" });
    expect(FEDERATION_DISCORD_CONFIG_ALLOWLIST).toEqual([
      "guild_id", "meta_category_id", "sessions_category_id", "status_category_id", "archive_category_id",
      "error_category_id", "session_forum_id", "test_forum_id", "task_workflow_forum_id", "activity_channel_id",
      "cost_channel_id", "monitor_channel_id", "pr_queue_channel_id", "error_channel_id",
    ]);
  });

  it("distributes a template resolved for the target site without leaking override rows", () => {
    db.prepare("INSERT INTO delegation_template_overrides (id, template_id, scope_kind, scope_key, patch_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("o-1", "t-1", "platform", "darwin", '{\"model\":\"native\"}', 1, 1, 1);
    db.prepare("INSERT INTO delegation_template_overrides (id, template_id, scope_kind, scope_key, patch_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("o-2", "t-1", "site", "site-a", '{\"model\":\"site\"}', 1, 1, 1);
    const snapshot = createFederationConfigSnapshot(db, [], { siteId: "site-a", platform: "darwin" });
    expect(snapshot.templates[0]?.model).toBe("site");
    expect(snapshot).not.toHaveProperty("overrides");
  });

  it("applies a site override when an older client omits its platform", () => {
    db.prepare("INSERT INTO delegation_template_overrides (id, template_id, scope_kind, scope_key, patch_json, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("o-site-only", "t-1", "site", "site-a", '{"model":"site"}', 1, 1, 1);
    const snapshot = createFederationConfigSnapshot(db, [], { siteId: "site-a", platform: null });
    expect(snapshot.templates[0]?.model).toBe("site");
  });
});
