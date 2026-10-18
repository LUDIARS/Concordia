// @implements spec/feature/discord-chat-relay.md — 中継トークン
import { describe, expect, it } from "vitest";
import { discordChatRelayAdminRouter } from "./admin-route.js";
import type { DiscordChatRelayTarget } from "./targets.js";

/** テスト値 (実物ではない)。 */
const TOKEN = "example-relay-token";

const targets: DiscordChatRelayTarget[] = [
  { name: "mf", url: "http://192.0.2.10/integrations/discord", host: null, channelIds: ["123456789012345678"], enabled: true },
];

function app() {
  const values = new Map<string, string>();
  const store = {
    get: (key: string) => values.get(key) ?? null,
    set: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => { values.delete(key); },
  };
  return { router: discordChatRelayAdminRouter({ targets: () => targets, store }), values };
}

const json = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("discordChatRelayAdminRouter", () => {
  it("一覧は target ごとのチャンネルと設定済みかどうかだけを返す", async () => {
    const { router } = app();
    const res = await router.request("/targets");
    expect(await res.json()).toEqual({
      targets: [{ name: "mf", enabled: true, channel_ids: ["123456789012345678"], relay_token_set: false }],
    });
  });

  it("中継トークンを保存・消去し、応答に値を含めない", async () => {
    const { router, values } = app();
    const put = await router.request("/targets/mf/secrets/relay_token", json({ value: ` ${TOKEN} ` }));
    expect(put.status).toBe(200);
    const body = await put.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toEqual({ ok: true, relay_token_set: true });
    expect(values.get("discord_chat_relay.mf.relay_token")).toBe(TOKEN);

    const del = await router.request("/targets/mf/secrets/relay_token", { method: "DELETE" });
    expect(await del.json()).toEqual({ ok: true, relay_token_set: false });
    expect(values.size).toBe(0);
  });

  it("未登録の target・未知の field は 404、空や長すぎる値は 400 で保存しない", async () => {
    const { router, values } = app();
    expect((await router.request("/targets/nope/secrets/relay_token", json({ value: TOKEN }))).status).toBe(404);
    expect((await router.request("/targets/mf/secrets/channel_secret", json({ value: TOKEN }))).status).toBe(404);
    expect((await router.request("/targets/mf/secrets/relay_token", json({ value: "  " }))).status).toBe(400);
    expect((await router.request("/targets/mf/secrets/relay_token", json({ value: "x".repeat(4097) }))).status).toBe(400);
    expect(values.size).toBe(0);
  });
});
