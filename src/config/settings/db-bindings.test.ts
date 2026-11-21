import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { EncryptedSettingsStore, SqliteSettingsStore } from "../../admin/settings-store.js";
import { makeDiscordConfigRepo } from "../../db/discord-repo.js";
import { makeRevisorConfigRepo } from "../../db/revisor-config-repo.js";
import { makeSlackConfigRepo } from "../../db/slack-config-repo.js";
import { SecretBox, isEncrypted } from "../../shared/secret-box.js";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { createSettingsDbReader, createSettingsDbWriter } from "./db-bindings.js";
import { applySettingUpdate } from "./apply.js";
import { getSetting } from "./registry.js";
import {
  decidePlaytestReviewAuth,
  PLAYTEST_INTAKE_TOKEN_SETTING,
  readPlaytestIntakeToken,
} from "../../playtest-review/playtest-review-auth.js";

describe("settings db bindings", () => {
  it("encrypts every WebUI persistence target and resolves the plaintext", () => {
    const db = makeTestDb();
    const secretBox = new SecretBox(randomBytes(32));
    const meta = new EncryptedSettingsStore(new SqliteSettingsStore(db), secretBox);
    const discord = makeDiscordConfigRepo(db);
    const slack = makeSlackConfigRepo(db);
    const revisor = makeRevisorConfigRepo(db);
    const bindings = { meta, discord, slack, revisor, secretBox };
    const writer = createSettingsDbWriter(bindings);

    writer.writeMeta("admin.mention_user_id", "123456");
    writer.writeDiscord("conn_guild_id", "G-123");
    writer.writeSlack("channel_id", "C-123");
    revisor.set("workflow_token_enc", secretBox.encrypt("rv-secret"));

    expect(isEncrypted((db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get("admin.mention_user_id") as { value: string }).value)).toBe(true);
    expect(isEncrypted(discord.get("conn_guild_id"))).toBe(true);
    expect(isEncrypted(slack.get("channel_id"))).toBe(true);

    const reader = createSettingsDbReader(bindings);
    expect(reader.readMeta("admin.mention_user_id")).toBe("123456");
    expect(reader.readDiscord("conn_guild_id")).toBe("G-123");
    expect(reader.readSlack("channel_id")).toBe("C-123");
    expect(reader.readRevisor("workflow_token_enc")).toBe("rv-secret");
  });

  it("AI プレイテスト受け口の鍵を schema_meta に暗号化して置き、 受け口は同じ store から復号して照合する (CC-PLAYTEST-INV-07)", () => {
    const db = makeTestDb();
    const secretBox = new SecretBox(randomBytes(32));
    // AdminState と同じ包み方 (secret-box があれば schema_meta 全体を暗号化する)。
    const meta = new EncryptedSettingsStore(new SqliteSettingsStore(db), secretBox);
    const bindings = { meta, secretBox };
    const token = "k".repeat(40); // テスト値 (実物ではない)

    expect(applySettingUpdate(PLAYTEST_INTAKE_TOKEN_SETTING, token, createSettingsDbWriter(bindings))).toEqual({ ok: true });
    const raw = (db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(PLAYTEST_INTAKE_TOKEN_SETTING) as { value: string }).value;
    expect(isEncrypted(raw)).toBe(true);
    expect(raw).not.toContain(token);
    // 画面は 「設定済み」 だけを見せ、 値は返さない。
    expect(getSetting(PLAYTEST_INTAKE_TOKEN_SETTING, createSettingsDbReader(bindings), {} as NodeJS.ProcessEnv))
      .toMatchObject({ set: true, value: null, source: "db" });

    const authorize = (presented: string | undefined) => decidePlaytestReviewAuth({
      presented,
      intakeToken: readPlaytestIntakeToken(() => meta.get(PLAYTEST_INTAKE_TOKEN_SETTING)),
      legacy: () => true,
    });
    expect(authorize(token)).toEqual({ allowed: true });
    expect(authorize("x".repeat(40))).toEqual({ allowed: false, reason: "mismatch" });
    expect(authorize(undefined)).toEqual({ allowed: false, reason: "missing" });

    // 別の secret-box では復号できない → 未設定とみなさず全て断る。
    const otherBox = new EncryptedSettingsStore(new SqliteSettingsStore(db), new SecretBox(randomBytes(32)));
    expect(decidePlaytestReviewAuth({
      presented: token,
      intakeToken: readPlaytestIntakeToken(() => otherBox.get(PLAYTEST_INTAKE_TOKEN_SETTING)),
      legacy: () => true,
    })).toEqual({ allowed: false, reason: "unreadable" });
  });

  it("secret-box が無ければ schema_meta の secret を平文で書かせない (secret でない値と消去は通す)", () => {
    const db = makeTestDb();
    const writer = createSettingsDbWriter({ meta: new SqliteSettingsStore(db) });
    expect(applySettingUpdate(PLAYTEST_INTAKE_TOKEN_SETTING, "k".repeat(40), writer))
      .toMatchObject({ ok: false, error: { code: "backend_unavailable", key: PLAYTEST_INTAKE_TOKEN_SETTING } });
    expect(db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(PLAYTEST_INTAKE_TOKEN_SETTING)).toBeUndefined();
    expect(applySettingUpdate(PLAYTEST_INTAKE_TOKEN_SETTING, null, writer)).toEqual({ ok: true });
    expect(applySettingUpdate("services.tabula_url", "http://127.0.0.1:5196", writer)).toEqual({ ok: true });
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
