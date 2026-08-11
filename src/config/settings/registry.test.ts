/**
 * レジストリの解決 (現在値と出所) と更新検証のテスト。
 *
 * 「secret の実値を返さない」 と 「出所が db|env|default|none で正しく出る」 が
 * W5 の受け入れ条件なので、 そこを中心に固定する。
 */

import { describe, expect, it } from "vitest";
import { applySettingUpdate, type SettingsDbWriter } from "./apply.js";
import { getSetting, listSettings, listSettingsBySection } from "./registry.js";
import type { SettingsDbReader } from "./resolve.js";

function reader(values: {
  meta?: Record<string, string>;
  discord?: Record<string, string>;
  slack?: Record<string, string>;
} = {}): SettingsDbReader {
  return {
    readMeta: (key) => values.meta?.[key] ?? null,
    readDiscord: (key) => values.discord?.[key] ?? null,
    readSlack: (key) => values.slack?.[key] ?? null,
  };
}

const NO_ENV = {} as NodeJS.ProcessEnv;

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

/** 呼ばれた書き込みを記録するだけの writer。 */
function recordingWriter(): SettingsDbWriter & { calls: Array<[string, string, string?]> } {
  const calls: Array<[string, string, string?]> = [];
  return {
    calls,
    checkWritable: () => null,
    transaction: (update) => update(),
    writeMeta: (k, v) => void calls.push(["writeMeta", k, v]),
    clearMeta: (k) => void calls.push(["clearMeta", k]),
    writeDiscord: (k, v) => void calls.push(["writeDiscord", k, v]),
    clearDiscord: (k) => void calls.push(["clearDiscord", k]),
    writeSlack: (k, v) => void calls.push(["writeSlack", k, v]),
    clearSlack: (k) => void calls.push(["clearSlack", k]),
    writeDiscordSecret: (k, v) => void calls.push(["writeDiscordSecret", k, v]),
    writeSlackSecret: (k, v) => void calls.push(["writeSlackSecret", k, v]),
  };
}

describe("出所 (source) の解決", () => {
  it("DB 上書きがあれば db", () => {
    const setting = getSetting("runtime.chat_muted", reader({ meta: { "admin.chat_muted": "0" } }), NO_ENV);
    expect(setting?.source).toBe("db");
    expect(setting?.value).toBe(false);
  });

  it("DB が無く env があれば env", () => {
    const setting = getSetting("workflow.reaction_enabled", reader(), env({ CONCORDIA_REACTION_WORKFLOW: "1" }));
    expect(setting?.source).toBe("env");
    expect(setting?.value).toBe(true);
  });

  it("どちらも無く既定があれば default", () => {
    const setting = getSetting("runtime.chat_muted", reader(), NO_ENV);
    expect(setting?.source).toBe("default");
    expect(setting?.value).toBe(true);
  });

  it("どちらも無く既定も無ければ none", () => {
    const setting = getSetting("runtime.mention_user_id", reader(), NO_ENV);
    expect(setting?.source).toBe("none");
    expect(setting?.value).toBeNull();
  });

  it("DB は env より優先される", () => {
    const setting = getSetting(
      "workflow.reaction_enabled",
      reader({ meta: { "admin.reaction_workflow_enabled": "0" } }),
      env({ CONCORDIA_REACTION_WORKFLOW: "1" }),
    );
    expect(setting?.source).toBe("db");
    expect(setting?.value).toBe(false);
  });

  it("Discord 設定は discord_config を引く", () => {
    const setting = getSetting("discord.guild_id", reader({ discord: { conn_guild_id: "G-DB" } }), NO_ENV);
    expect(setting?.source).toBe("db");
    expect(setting?.value).toBe("G-DB");
  });

  it("空文字の env は未設定として扱う", () => {
    const setting = getSetting("discord.guild_id", reader(), env({ CONCORDIA_DISCORD_GUILD_ID: "   " }));
    expect(setting?.source).toBe("none");
  });
});

describe("secret の redaction", () => {
  it("値を返さず set フラグだけを返す", () => {
    const configured = getSetting("discord.token", reader({ discord: { conn_token_enc: "enc:xxx" } }), NO_ENV);
    expect(configured?.value).toBeNull();
    expect(configured?.set).toBe(true);
    expect(configured?.source).toBe("db");
  });

  it("未設定なら set=false", () => {
    const missing = getSetting("discord.token", reader(), NO_ENV);
    expect(missing?.value).toBeNull();
    expect(missing?.set).toBe(false);
  });

  it("一覧に secret の実値がどこにも出ない", () => {
    const settings = listSettings(
      reader({ discord: { conn_token_enc: "super-secret-token" } }),
      env({ CONCORDIA_SLACK_BOT_TOKEN: "fixture-slack-credential", CONCORDIA_REVISOR_TOKEN: "rv-secret" }),
    );
    const serialized = JSON.stringify(settings);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("fixture-slack-credential");
    expect(serialized).not.toContain("rv-secret");
    for (const setting of settings.filter((s) => s.kind === "secret")) {
      expect(setting.value).toBeNull();
      expect(typeof setting.set).toBe("boolean");
    }
  });
});

describe("セクション分け", () => {
  it("空でないセクションだけを定義順に返す", () => {
    const sections = listSettingsBySection(reader(), NO_ENV);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((section) => section.settings.length > 0)).toBe(true);
    expect(sections[0]?.id).toBe("core");
  });
});

describe("更新の検証", () => {
  it("未知キーを拒否する", () => {
    const result = applySettingUpdate("nope.not_a_setting", true, recordingWriter());
    expect(result).toEqual({ ok: false, error: { code: "unknown_key", key: "nope.not_a_setting" } });
  });

  it("env 専用の項目は編集を拒否する", () => {
    const result = applySettingUpdate("core.port", 12345, recordingWriter());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_editable");
  });

  it("構造化設定は専用 UI を案内して拒否する", () => {
    const result = applySettingUpdate("runtime.cron_job_overrides", {}, recordingWriter());
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "not_editable") {
      expect(result.error.managedBy).toBe("設定 > cron ジョブ");
    } else {
      throw new Error("expected not_editable with managedBy");
    }
  });

  it("型が違えば拒否する", () => {
    const result = applySettingUpdate("runtime.chat_muted", "yes", recordingWriter());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_value");
  });

  it("整数の小数と定義された下限未満を拒否する", () => {
    for (const value of [1.5, 0, -1]) {
      const result = applySettingUpdate("session.reaper_session_end_grace_sec", value, recordingWriter());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_value");
    }
  });

  it("enum の範囲外を拒否する", () => {
    const result = applySettingUpdate("runtime.lictor_mode", "staging", recordingWriter());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_value");
  });

  it("boolean を schema_meta へ書く", () => {
    const writer = recordingWriter();
    expect(applySettingUpdate("runtime.chat_muted", false, writer).ok).toBe(true);
    expect(writer.calls).toEqual([["writeMeta", "admin.chat_muted", "0"]]);
  });

  it("空文字は上書きの削除として扱う", () => {
    const writer = recordingWriter();
    expect(applySettingUpdate("runtime.mention_user_id", "", writer).ok).toBe(true);
    expect(writer.calls).toEqual([["clearMeta", "admin.mention_user_id"]]);
  });

  it("一覧は JSON 配列で保存する", () => {
    const writer = recordingWriter();
    expect(applySettingUpdate("harness.strong_impl_models", [" fable ", "", "sol-ultra"], writer).ok).toBe(true);
    expect(writer.calls).toEqual([["writeMeta", "harness.strong_impl_models", '["fable","sol-ultra"]']]);
  });

  it("Discord の secret は暗号化経路へ回す", () => {
    const writer = recordingWriter();
    expect(applySettingUpdate("discord.token", "tok", writer).ok).toBe(true);
    expect(writer.calls).toEqual([["writeDiscordSecret", "conn_token_enc", "tok"]]);
  });

  it("session-end 回収猶予を DB 上書き可能な設定として書く", () => {
    const writer = recordingWriter();
    expect(applySettingUpdate("session.reaper_session_end_grace_sec", 180, writer).ok).toBe(true);
    expect(writer.calls).toEqual([["writeMeta", "admin.reaper_session_end_grace_sec", "180"]]);
  });
});
