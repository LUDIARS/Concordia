import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { applyMigrations } from "../db/schema.js";
import { makeSlackConfigRepo, type SlackConfigRepo } from "../db/slack-config-repo.js";
import { SecretBox, isEncrypted } from "../shared/secret-box.js";
import { resolveSlackConfig, setSlackConfig, slackConfigStatus } from "./config.js";

let db: Database.Database;
let repo: SlackConfigRepo;
let box: SecretBox;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  repo = makeSlackConfigRepo(db);
  box = new SecretBox(randomBytes(32));
});
afterEach(() => db.close());

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe("slack/config", () => {
  it("stores tokens encrypted at rest and resolves them decrypted", () => {
    setSlackConfig(repo, box, { enabled: true, channelId: "C-DB", botToken: "xoxb-a", appToken: "xapp-b" });

    // DB の生値は暗号化されており平文 token を含まない
    const rawBot = repo.get("bot_token_enc");
    expect(isEncrypted(rawBot)).toBe(true);
    expect(rawBot).not.toContain("xoxb-a");

    const resolved = resolveSlackConfig(repo, box, EMPTY_ENV);
    expect(resolved.enabled).toBe(true);
    expect(resolved.channelId).toBe("C-DB");
    expect(resolved.botToken).toBe("xoxb-a");
    expect(resolved.appToken).toBe("xapp-b");
  });

  it("DB values take precedence over env", () => {
    const env = {
      CONCORDIA_SLACK_ENABLED: "1",
      CONCORDIA_SLACK_CHANNEL_ID: "C-ENV",
      CONCORDIA_SLACK_BOT_TOKEN: "xoxb-env",
      CONCORDIA_SLACK_APP_TOKEN: "xapp-env",
    } as unknown as NodeJS.ProcessEnv;

    setSlackConfig(repo, box, { channelId: "C-DB", botToken: "xoxb-db" });
    const resolved = resolveSlackConfig(repo, box, env);
    expect(resolved.channelId).toBe("C-DB"); // DB
    expect(resolved.botToken).toBe("xoxb-db"); // DB
    expect(resolved.appToken).toBe("xapp-env"); // env fallback (DB 未設定)
  });

  it("clearing a field (empty string) falls back to env", () => {
    const env = { CONCORDIA_SLACK_CHANNEL_ID: "C-ENV" } as unknown as NodeJS.ProcessEnv;
    setSlackConfig(repo, box, { channelId: "C-DB" });
    expect(resolveSlackConfig(repo, box, env).channelId).toBe("C-DB");
    setSlackConfig(repo, box, { channelId: "" }); // クリア
    expect(repo.get("channel_id")).toBeNull();
    expect(resolveSlackConfig(repo, box, env).channelId).toBe("C-ENV");
  });

  it("undefined leaves a field untouched", () => {
    setSlackConfig(repo, box, { botToken: "xoxb-keep" });
    setSlackConfig(repo, box, { channelId: "C-1" }); // botToken は触らない
    expect(resolveSlackConfig(repo, box, EMPTY_ENV).botToken).toBe("xoxb-keep");
  });

  it("status redacts token values and reports source", () => {
    setSlackConfig(repo, box, { enabled: true, channelId: "C-DB", botToken: "xoxb-a" });
    const st = slackConfigStatus(repo, box, EMPTY_ENV);
    expect(st.bot_token_set).toBe(true);
    expect(st.app_token_set).toBe(false);
    expect(st.source.bot_token).toBe("db");
    expect(st.source.app_token).toBe("none");
    // token 値が status に漏れていないこと
    expect(JSON.stringify(st)).not.toContain("xoxb-a");
  });
});
