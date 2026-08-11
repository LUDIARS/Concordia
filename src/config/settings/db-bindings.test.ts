import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { EncryptedSettingsStore, SqliteSettingsStore } from "../../admin/settings-store.js";
import { makeDiscordConfigRepo } from "../../db/discord-repo.js";
import { makeSlackConfigRepo } from "../../db/slack-config-repo.js";
import { SecretBox, isEncrypted } from "../../shared/secret-box.js";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { createSettingsDbReader, createSettingsDbWriter } from "./db-bindings.js";

describe("settings db bindings", () => {
  it("encrypts every WebUI persistence target and resolves the plaintext", () => {
    const db = makeTestDb();
    const secretBox = new SecretBox(randomBytes(32));
    const meta = new EncryptedSettingsStore(new SqliteSettingsStore(db), secretBox);
    const discord = makeDiscordConfigRepo(db);
    const slack = makeSlackConfigRepo(db);
    const bindings = { meta, discord, slack, secretBox };
    const writer = createSettingsDbWriter(bindings);

    writer.writeMeta("admin.mention_user_id", "123456");
    writer.writeDiscord("conn_guild_id", "G-123");
    writer.writeSlack("channel_id", "C-123");

    expect(isEncrypted((db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get("admin.mention_user_id") as { value: string }).value)).toBe(true);
    expect(isEncrypted(discord.get("conn_guild_id"))).toBe(true);
    expect(isEncrypted(slack.get("channel_id"))).toBe(true);

    const reader = createSettingsDbReader(bindings);
    expect(reader.readMeta("admin.mention_user_id")).toBe("123456");
    expect(reader.readDiscord("conn_guild_id")).toBe("G-123");
    expect(reader.readSlack("channel_id")).toBe("C-123");
  });

  it("rolls back a batch spanning all persistence tables", () => {
    const db = makeTestDb();
    const secretBox = new SecretBox(randomBytes(32));
    const meta = new EncryptedSettingsStore(new SqliteSettingsStore(db), secretBox);
    const discord = makeDiscordConfigRepo(db);
    const slack = makeSlackConfigRepo(db);
    const writer = createSettingsDbWriter({ meta, discord, slack, secretBox });

    expect(() => writer.transaction(() => {
      writer.writeMeta("admin.mention_user_id", "123456");
      writer.writeDiscord("conn_guild_id", "G-123");
      writer.writeSlack("channel_id", "C-123");
      throw new Error("fixture rollback");
    })).toThrow("fixture rollback");

    expect(meta.get("admin.mention_user_id")).toBeNull();
    expect(discord.get("conn_guild_id")).toBeNull();
    expect(slack.get("channel_id")).toBeNull();
  });
});
