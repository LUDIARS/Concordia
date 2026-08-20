/**
 * `/v1/admin/settings` の HTTP レベルのテスト (W5-2)。
 *
 * secret が API 応答に漏れないこと、 受け付けられない更新が 400 で理由付きに落ちること、
 * 更新が部分適用されないことを固定する。
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { settingsRouter } from "../src/api/settings.js";
import type { SettingsDbWriter } from "../src/config/settings/apply.js";
import type { SettingsDbReader } from "../src/config/settings/resolve.js";

interface Stores {
  meta: Record<string, string>;
  discord: Record<string, string>;
  slack: Record<string, string>;
  /** revisor_config (workflow_token_enc)。 読み取り専用で、 汎用 PUT の対象にならない。 */
  revisor: Record<string, string>;
}

function makeApp(
  initial: Partial<Stores> = {},
  options: { unavailableTarget?: "discord" | "slack"; failOnWrite?: "discord" | "slack" } = {},
) {
  const stores: Stores = { meta: {}, discord: {}, slack: {}, revisor: {}, ...initial };
  const reader: SettingsDbReader = {
    readMeta: (key) => stores.meta[key] ?? null,
    readDiscord: (key) => stores.discord[key] ?? null,
    readSlack: (key) => stores.slack[key] ?? null,
    readRevisor: (key) => stores.revisor[key] ?? null,
  };
  const writer: SettingsDbWriter = {
    checkWritable: (target) => target === options.unavailableTarget ? `${target} backend is unavailable` : null,
    transaction: (update) => {
      // revisor は汎用 PUT の書き込み対象ではないので巻き戻し対象にも入れない。
      const before: Omit<Stores, "revisor"> = {
        meta: { ...stores.meta },
        discord: { ...stores.discord },
        slack: { ...stores.slack },
      };
      try {
        return update();
      } catch (error) {
        stores.meta = before.meta;
        stores.discord = before.discord;
        stores.slack = before.slack;
        throw error;
      }
    },
    writeMeta: (k, v) => void (stores.meta[k] = v),
    clearMeta: (k) => void delete stores.meta[k],
    writeDiscord: (k, v) => void (stores.discord[k] = v),
    clearDiscord: (k) => void delete stores.discord[k],
    writeSlack: (k, v) => void (stores.slack[k] = v),
    clearSlack: (k) => void delete stores.slack[k],
    writeDiscordSecret: (k, v) => {
      if (options.failOnWrite === "discord") throw new Error("fixture write failure");
      stores.discord[k] = `enc(${v})`;
    },
    writeSlackSecret: (k, v) => {
      if (options.failOnWrite === "slack") throw new Error("fixture write failure");
      stores.slack[k] = `enc(${v})`;
    },
  };
  const changed: string[][] = [];
  const app = new Hono();
  app.route("/v1/admin/settings", settingsRouter({ reader, writer, onChanged: (keys) => void changed.push(keys) }));
  return { app, stores, changed };
}

async function put(app: Hono, updates: Record<string, unknown>): Promise<Response> {
  return app.request("/v1/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  });
}

describe("GET /v1/admin/settings", () => {
  it("セクション分けで全項目を返す", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/admin/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sections: Array<{ id: string; settings: unknown[] }> };
    expect(body.sections.length).toBeGreaterThan(5);
    const total = body.sections.reduce((sum, section) => sum + section.settings.length, 0);
    expect(total).toBeGreaterThan(80);
  });

  it("各項目が値・出所・env 名・既定値を持つ", async () => {
    const { app } = makeApp({ meta: { "admin.chat_muted": "0" } });
    const res = await app.request("/v1/admin/settings");
    const body = (await res.json()) as {
      sections: Array<{ settings: Array<Record<string, unknown>> }>;
    };
    const all = body.sections.flatMap((section) => section.settings);
    const chatMuted = all.find((setting) => setting.key === "runtime.chat_muted");
    expect(chatMuted).toMatchObject({ value: false, source: "db", editable: true, dbKey: "admin.chat_muted" });
    for (const setting of all) {
      expect(setting).toHaveProperty("source");
      expect(setting).toHaveProperty("label");
      expect(setting).toHaveProperty("description");
    }
  });

  it("secret の実値を返さない", async () => {
    const { app } = makeApp({ discord: { conn_token_enc: "PLAINTEXT-TOKEN" } });
    const res = await app.request("/v1/admin/settings");
    const text = await res.text();
    expect(text).not.toContain("PLAINTEXT-TOKEN");
    const body = JSON.parse(text) as { sections: Array<{ settings: Array<Record<string, unknown>> }> };
    const token = body.sections
      .flatMap((section) => section.settings)
      .find((setting) => setting.key === "discord.token");
    expect(token).toMatchObject({ value: null, set: true });
  });
});

describe("PUT /v1/admin/settings", () => {
  it("キー単位で更新する", async () => {
    const { app, stores, changed } = makeApp();
    const res = await put(app, { "runtime.chat_muted": false, "runtime.daily_token_budget": 500 });
    expect(res.status).toBe(200);
    expect(stores.meta["admin.chat_muted"]).toBe("0");
    expect(stores.meta["admin.daily_token_budget"]).toBe("500");
    expect(changed).toEqual([["runtime.chat_muted", "runtime.daily_token_budget"]]);
  });

  it("secret は暗号化経路を通って保存され、応答に実値が出ない", async () => {
    const { app, stores } = makeApp();
    const res = await put(app, { "discord.token": "raw-token" });
    expect(res.status).toBe(200);
    expect(stores.discord["conn_token_enc"]).toBe("enc(raw-token)");
    expect(await res.text()).not.toContain("raw-token");
  });

  it("未知キーを 400 で拒否する", async () => {
    const { app } = makeApp();
    const res = await put(app, { "nope.missing": 1 });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({
      error: "rejected",
      rejected: [{ code: "unknown_key", key: "nope.missing" }],
    });
  });

  it("env 専用の項目を 400 で拒否する", async () => {
    const { app } = makeApp();
    const res = await put(app, { "core.port": 20000 });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({
      rejected: [{ code: "not_editable", key: "core.port" }],
    });
  });

  it("1 件でも不正なら何も書かない (部分適用しない)", async () => {
    const { app, stores, changed } = makeApp();
    const res = await put(app, { "runtime.chat_muted": false, "core.port": 20000 });
    expect(res.status).toBe(400);
    expect(stores.meta).toEqual({});
    expect(changed).toEqual([]);
  });

  it("保存先が無い batch は書き込み前に拒否する", async () => {
    const { app, stores, changed } = makeApp({}, { unavailableTarget: "slack" });
    const res = await put(app, { "runtime.chat_muted": false, "slack.bot_token": "xoxb-test" });
    expect(res.status).toBe(400);
    expect(stores.meta).toEqual({});
    expect(stores.slack).toEqual({});
    expect(changed).toEqual([]);
    expect((await res.json()) as unknown).toMatchObject({
      rejected: [{ code: "backend_unavailable", key: "slack.bot_token" }],
    });
  });

  it("途中の DB 例外は batch 全体を rollback する", async () => {
    const { app, stores, changed } = makeApp({}, { failOnWrite: "slack" });
    const res = await put(app, { "runtime.chat_muted": false, "slack.bot_token": "xoxb-test" });
    expect(res.status).toBe(503);
    expect(stores.meta).toEqual({});
    expect(stores.slack).toEqual({});
    expect(changed).toEqual([]);
    expect(await res.json()).toEqual({ error: "persistence_failed" });
  });

  it("実効値に反映されない整数を拒否する", async () => {
    const { app, stores } = makeApp();
    const res = await put(app, { "session.reaper_session_end_grace_sec": 0 });
    expect(res.status).toBe(400);
    expect(stores.meta).toEqual({});
    expect((await res.json()) as unknown).toMatchObject({
      rejected: [{ code: "invalid_value", key: "session.reaper_session_end_grace_sec" }],
    });
  });

  it("空の updates を拒否する", async () => {
    const { app } = makeApp();
    const res = await put(app, {});
    expect(res.status).toBe(400);
  });
});
