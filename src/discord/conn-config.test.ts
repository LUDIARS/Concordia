import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordConfigRepo, type DiscordConfigRepo } from "../db/discord-repo.js";
import { SecretBox, isEncrypted } from "../shared/secret-box.js";
import { resolveDiscordConfig, setDiscordConfig, discordConfigStatus } from "./conn-config.js";

let repo: DiscordConfigRepo;
let box: SecretBox;

beforeEach(() => {
  const db = makeTestDb();
  repo = makeDiscordConfigRepo(db);
  box = new SecretBox(randomBytes(32));
});

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
    expect(resolved.permissionRequestsEnabled).toBe(false);
    expect(resolved.messageOptimizationEnabled).toBe(true);
  });

  it("DB values take precedence over env", () => {
    const env = {
      CONCORDIA_DISCORD_ENABLED: "1",
      CONCORDIA_DISCORD_GUILD_ID: "G-ENV",
      CONCORDIA_DISCORD_TOKEN: "tok-env",
      CONCORDIA_DISCORD_APPLICATION_ID: "A-ENV",
      CONCORDIA_DISCORD_PERMISSION_REQUESTS_ENABLED: "1",
      CONCORDIA_DISCORD_MESSAGE_OPTIMIZATION_ENABLED: "0",
    } as unknown as NodeJS.ProcessEnv;

    setDiscordConfig(repo, box, {
      guildId: "G-DB",
      token: "tok-db",
      permissionRequestsEnabled: false,
      messageOptimizationEnabled: true,
    });
    const resolved = resolveDiscordConfig(repo, box, env);
    expect(resolved.guildId).toBe("G-DB"); // DB
    expect(resolved.token).toBe("tok-db"); // DB
    expect(resolved.applicationId).toBe("A-ENV"); // env fallback (DB 未設定)
    expect(resolved.permissionRequestsEnabled).toBe(false); // DB
    expect(resolved.messageOptimizationEnabled).toBe(true); // DB
  });

  it("uses env/defaults for Discord message settings when DB is unset", () => {
    expect(resolveDiscordConfig(repo, box, EMPTY_ENV)).toMatchObject({
      permissionRequestsEnabled: false,
      messageOptimizationEnabled: true,
    });
    const env = {
      CONCORDIA_DISCORD_PERMISSION_REQUESTS_ENABLED: "1",
      CONCORDIA_DISCORD_MESSAGE_OPTIMIZATION_ENABLED: "0",
    } as unknown as NodeJS.ProcessEnv;
    expect(resolveDiscordConfig(repo, box, env)).toMatchObject({
      permissionRequestsEnabled: true,
      messageOptimizationEnabled: false,
    });
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
    expect(st.permission_requests_enabled).toBe(false);
    expect(st.message_optimization_enabled).toBe(true);
    expect(st.source.permission_requests_enabled).toBe("none");
    expect(st.source.message_optimization_enabled).toBe("default");
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
