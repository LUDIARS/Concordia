import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { applyMigrations } from "../db/schema.js";
import { makeDiscordConfigRepo, type DiscordConfigRepo } from "../db/discord-repo.js";
import { SecretBox, isEncrypted } from "../shared/secret-box.js";
import { resolveDiscordConfig, setDiscordConfig, discordConfigStatus } from "./conn-config.js";

let db: Database.Database;
let repo: DiscordConfigRepo;
let box: SecretBox;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  repo = makeDiscordConfigRepo(db);
  box = new SecretBox(randomBytes(32));
});
afterEach(() => db.close());

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe("discord/conn-config", () => {
  it("stores token encrypted at rest and resolves it decrypted", () => {
    setDiscordConfig(repo, box, {
      enabled: true,
      guildId: "G-DB",
      applicationId: "A-DB",
      token: "tok-secret",
    });

    // DB の生値は暗号化されており平文 token を含まない
    const rawToken = repo.get("conn_token_enc");
    expect(isEncrypted(rawToken)).toBe(true);
    expect(rawToken).not.toContain("tok-secret");

    const resolved = resolveDiscordConfig(repo, box, EMPTY_ENV);
    expect(resolved.enabled).toBe(true);
    expect(resolved.guildId).toBe("G-DB");
    expect(resolved.applicationId).toBe("A-DB");
    expect(resolved.token).toBe("tok-secret");
  });

  it("DB values take precedence over env", () => {
    const env = {
      CONCORDIA_DISCORD_ENABLED: "1",
      CONCORDIA_DISCORD_GUILD_ID: "G-ENV",
      CONCORDIA_DISCORD_TOKEN: "tok-env",
      CONCORDIA_DISCORD_APPLICATION_ID: "A-ENV",
    } as unknown as NodeJS.ProcessEnv;

    setDiscordConfig(repo, box, { guildId: "G-DB", token: "tok-db" });
    const resolved = resolveDiscordConfig(repo, box, env);
    expect(resolved.guildId).toBe("G-DB"); // DB
    expect(resolved.token).toBe("tok-db"); // DB
    expect(resolved.applicationId).toBe("A-ENV"); // env fallback (DB 未設定)
  });

  it("clearing a field (empty string) falls back to env", () => {
    const env = { CONCORDIA_DISCORD_GUILD_ID: "G-ENV" } as unknown as NodeJS.ProcessEnv;
    setDiscordConfig(repo, box, { guildId: "G-DB" });
    expect(resolveDiscordConfig(repo, box, env).guildId).toBe("G-DB");
    setDiscordConfig(repo, box, { guildId: "" }); // クリア
    expect(repo.get("conn_guild_id")).toBeNull();
    expect(resolveDiscordConfig(repo, box, env).guildId).toBe("G-ENV");
  });

  it("undefined leaves a field untouched", () => {
    setDiscordConfig(repo, box, { token: "tok-keep" });
    setDiscordConfig(repo, box, { guildId: "G-1" }); // token は触らない
    expect(resolveDiscordConfig(repo, box, EMPTY_ENV).token).toBe("tok-keep");
  });

  it("status redacts token value and reports source", () => {
    setDiscordConfig(repo, box, { enabled: true, guildId: "G-DB", token: "tok-a" });
    const st = discordConfigStatus(repo, box, EMPTY_ENV);
    expect(st.token_set).toBe(true);
    expect(st.source.token).toBe("db");
    expect(st.source.application_id).toBe("none");
    // token 値が status に漏れていないこと
    expect(JSON.stringify(st)).not.toContain("tok-a");
  });

  it("does not collide with channel/category id keys", () => {
    // 既存の discord_config キー (channel id 等) を別途 set しても接続設定に影響しない
    repo.set("guild_id", "LEGACY"); // src/discord/config.ts の ensureDiscordLayout 系キー
    setDiscordConfig(repo, box, { guildId: "G-DB" });
    expect(resolveDiscordConfig(repo, box, EMPTY_ENV).guildId).toBe("G-DB");
    expect(repo.get("guild_id")).toBe("LEGACY"); // legacy キーは無傷
  });
});
