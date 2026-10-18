import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lineWebhookAdminRouter } from "./admin-route.js";
import {
  clearLineChannelSecret,
  describeLineChannelSecrets,
  readLineChannelSecrets,
  readServiceRelayToken,
  setLineChannelSecret,
  setServiceRelayToken,
  type LineChannelSecretStore,
} from "./channel-secrets.js";
import { buildRelayHeaders } from "./relay-headers.js";
import { parseServiceAnswer, parseServiceReplies } from "./replies.js";
import { createLineReplySender } from "./reply-client.js";
import { verifyLineSignature } from "./signature.js";
import { MemoryLineTalkLinkStore } from "./talk-links.js";
import { readLineWebhookTargets } from "./targets.js";

const SECRET = "example-channel-secret";
const sign = (body: Uint8Array, secret = SECRET) => createHmac("sha256", secret).update(body).digest("base64");

function memoryStore(): LineChannelSecretStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get: (key) => rows.get(key) ?? null,
    set: (key, value) => { rows.set(key, value); },
    delete: (key) => { rows.delete(key); },
  };
}

describe("verifyLineSignature", () => {
  const body = Buffer.from('{ "events" : [ ], "destination":"U0" }', "utf8");

  it("本文バイト列の HMAC-SHA256 (base64) と一致するときだけ true", () => {
    expect(verifyLineSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyLineSignature(SECRET, body, sign(body, "other-secret"))).toBe(false);
    // 1 バイトでも違う本文 (再直列化した JSON 等) は一致しない。
    expect(verifyLineSignature(SECRET, Buffer.from('{"events":[],"destination":"U0"}'), sign(body))).toBe(false);
  });

  it("署名が無い・base64 でない・シークレットが空なら false", () => {
    expect(verifyLineSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyLineSignature(SECRET, body, "")).toBe(false);
    expect(verifyLineSignature(SECRET, body, "not base64 !!")).toBe(false);
    expect(verifyLineSignature("", body, sign(body, ""))).toBe(false);
  });
});

describe("parseServiceReplies / parseServiceAnswer", () => {
  const raw = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  const messages = [{ type: "text", text: "おつかれさま" }];

  it("replies の各要素を返す (返事が無ければ空配列)", () => {
    expect(parseServiceReplies(raw({ replies: [] }))).toEqual([]);
    expect(parseServiceReplies(raw({ replies: [{ replyToken: "r-1", messages }] }))).toEqual([{ replyToken: "r-1", messages }]);
  });

  it("形が違えば null", () => {
    const text = { type: "text", text: "x" };
    for (const value of [
      "not json", {}, { replies: {} },
      { replies: [{ replyToken: "", messages: [text] }] },
      { replies: [{ replyToken: "r", messages: [] }] },
      { replies: [{ replyToken: "r", messages: Array(6).fill(text) }] },
      { replies: [{ replyToken: "r", messages: ["text"] }] },
    ]) {
      expect(parseServiceReplies(raw(value))).toBeNull();
      expect(parseServiceAnswer(raw(value))).toBeNull();
    }
  });

  it("linked / unlinked は true のときだけ true、省略は false、真偽値でなければ null", () => {
    expect(parseServiceAnswer(raw({ replies: [] }))).toEqual({ replies: [], linked: false, unlinked: false });
    expect(parseServiceAnswer(raw({ replies: [{ replyToken: "r-1", messages }], linked: true })))
      .toEqual({ replies: [{ replyToken: "r-1", messages }], linked: true, unlinked: false });
    expect(parseServiceAnswer(raw({ replies: [], unlinked: true, linked: false })))
      .toEqual({ replies: [], linked: false, unlinked: true });
    expect(parseServiceAnswer(raw({ replies: [], linked: "yes" }))).toBeNull();
  });
});

describe("buildRelayHeaders", () => {
  it("Content-Type・中継トークン・サービス名・チャネル名・Content-Length を付け、host 指定時は Host を上書きする", () => {
    expect(buildRelayHeaders({ name: "mf", channel: "ludiars", host: "mf-hook.example.test" }, "relay-token-example", 12)).toEqual({
      "content-type": "application/json",
      authorization: "Bearer relay-token-example",
      "x-concordia-line-target": "mf",
      "x-concordia-line-channel": "ludiars",
      "content-length": "12",
      host: "mf-hook.example.test",
    });
  });

  it("host 未指定なら Host を付けず、X-Line-Signature は送らない", () => {
    const headers = buildRelayHeaders({ name: "mf", channel: "mf", host: null }, "relay-token-example", 0);
    expect(headers).not.toHaveProperty("host");
    expect(headers).not.toHaveProperty("x-line-signature");
  });
});

describe("秘密値", () => {
  it("チャネルごとに保存・差し替え・消去でき、状態は真偽値だけ", () => {
    const store = memoryStore();
    expect(describeLineChannelSecrets(store, "ludiars")).toEqual({ channel_secret_set: false, channel_access_token_set: false });
    setLineChannelSecret(store, "ludiars", "channel_secret", "s-1");
    setLineChannelSecret(store, "ludiars", "channel_secret", "s-2");
    expect(store.rows.get("line_webhook.channel.ludiars.channel_secret")).toBe("s-2");
    expect(readLineChannelSecrets(store, "ludiars")).toEqual({ channelSecret: "s-2", channelAccessToken: null });
    expect(readLineChannelSecrets(store, "other").channelSecret).toBeNull();
    clearLineChannelSecret(store, "ludiars", "channel_secret");
    expect(describeLineChannelSecrets(store, "ludiars")).toEqual({ channel_secret_set: false, channel_access_token_set: false });
  });

  it("中継トークンはサービスごとのキーに置く", () => {
    const store = memoryStore();
    setServiceRelayToken(store, "mf", "t-1");
    expect(store.rows.get("line_webhook.service.mf.relay_token")).toBe("t-1");
    expect(readServiceRelayToken(store, "mf")).toBe("t-1");
    expect(readServiceRelayToken(store, "mm")).toBeNull();
  });

  it("復号できない値は未設定として扱う", () => {
    const store: LineChannelSecretStore = {
      get: () => { throw new Error("cannot decrypt persisted setting"); },
      set: () => undefined,
      delete: () => undefined,
    };
    expect(readLineChannelSecrets(store, "ludiars").channelSecret).toBeNull();
    expect(describeLineChannelSecrets(store, "ludiars").channel_secret_set).toBe(false);
    expect(readServiceRelayToken(store, "mf")).toBeNull();
  });
});

describe("lineWebhookAdminRouter", () => {
  const entries = [
    JSON.stringify({ name: "mf", url: "http://192.0.2.10:8080/integrations/line/webhook", enabled: true, channel: "ludiars", keywords: ["おてつだい"] }),
    JSON.stringify({ name: "mm", url: "http://192.0.2.11/hook", enabled: false, channel: "ludiars" }),
  ];
  /** テスト値 (実物ではない)。 */
  const GROUP = "C0123456789abcdef0123456789abcdef";

  function setup() {
    const store = memoryStore();
    const talkLinks = new MemoryLineTalkLinkStore();
    let setting: string | null = JSON.stringify(entries);
    const app = lineWebhookAdminRouter({
      targets: () => readLineWebhookTargets(setting),
      store,
      talkLinks,
      readTargetsSetting: () => setting,
      writeTargetsSetting: (next) => { setting = JSON.stringify(next); },
    });
    return { store, talkLinks, app, setting: () => setting };
  }

  const put = (app: ReturnType<typeof setup>["app"], path: string, body: unknown) => app.request(path, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("チャネルの一覧は Webhook の経路・サービス・設定済みかどうかだけを返し、保存した値を読み返さない", async () => {
    const { store, app } = setup();
    const res = await put(app, "/channels/ludiars/secrets/channel_secret", { value: " s-example " });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("s-example");
    expect(store.rows.get("line_webhook.channel.ludiars.channel_secret")).toBe("s-example");

    const text = await (await app.request("/channels")).text();
    expect(text).not.toContain("s-example");
    expect(JSON.parse(text)).toEqual({
      channels: [{
        name: "ludiars", webhook_path: "/hooks/line/ludiars", services: ["mf", "mm"],
        channel_secret_set: true, channel_access_token_set: false,
      }],
    });
  });

  it("サービスの中継トークンを入力・消去でき、一覧は呼びかけの言葉と設定済みかどうかを返す", async () => {
    const { store, app } = setup();
    expect((await put(app, "/services/mf/relay-token", { value: "t-example" })).status).toBe(200);
    expect(store.rows.get("line_webhook.service.mf.relay_token")).toBe("t-example");
    const text = await (await app.request("/services")).text();
    expect(text).not.toContain("t-example");
    expect(JSON.parse(text)).toEqual({ services: [
      { name: "mf", channel: "ludiars", enabled: true, keywords: ["おてつだい"], relay_token_set: true },
      { name: "mm", channel: "ludiars", enabled: false, keywords: [], relay_token_set: false },
    ] });
    expect(await (await app.request("/services/mf/relay-token", { method: "DELETE" })).json()).toEqual({ ok: true, relay_token_set: false });
    expect(store.rows.size).toBe(0);
  });

  it("呼びかけの言葉はそのサービスの行の keywords だけを書き換える", async () => {
    const { app, setting } = setup();
    const res = await put(app, "/services/mm/keywords", { keywords: [" メモリア ", "きろく"] });
    expect(await res.json()).toEqual({ ok: true, keywords: ["メモリア", "きろく"] });
    const saved = JSON.parse(setting()!) as string[];
    expect(saved[0]).toBe(entries[0]);
    expect(JSON.parse(saved[1]!)).toEqual({ ...JSON.parse(entries[1]!), keywords: ["メモリア", "きろく"] });
    expect((await put(app, "/services/mm/keywords", { keywords: "メモリア" })).status).toBe(400);
    expect((await put(app, "/services/unknown/keywords", { keywords: [] })).status).toBe(404);
  });

  it("紐付けはトーク ID の先頭数文字だけを返し、ふだんの相手の変更と解除ができる", async () => {
    const { app, talkLinks } = setup();
    talkLinks.link("ludiars", GROUP, "mf", 10);
    talkLinks.link("ludiars", GROUP, "mm", 20);
    const text = await (await app.request("/links")).text();
    expect(text).not.toContain(GROUP);
    const { links } = JSON.parse(text) as { links: Array<{ id: number; service: string; is_default: boolean }> };
    expect(links).toEqual([
      { id: expect.any(Number), channel: "ludiars", talk_kind: "group", talk_id_prefix: "C0123", service: "mf", is_default: true, linked_at: 10 },
      { id: expect.any(Number), channel: "ludiars", talk_kind: "group", talk_id_prefix: "C0123", service: "mm", is_default: false, linked_at: 20 },
    ]);
    const mm = links.find((link) => link.service === "mm")!;
    expect((await app.request(`/links/${mm.id}/default`, { method: "PUT" })).status).toBe(200);
    expect(talkLinks.forTalk("ludiars", GROUP)).toEqual([{ service: "mf", isDefault: false }, { service: "mm", isDefault: true }]);
    expect((await app.request(`/links/${mm.id}`, { method: "DELETE" })).status).toBe(200);
    expect(talkLinks.forTalk("ludiars", GROUP)).toEqual([{ service: "mf", isDefault: false }]);
    expect((await app.request(`/links/${mm.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request("/links/abc/default", { method: "PUT" })).status).toBe(404);
  });

  it("未登録のチャネル / サービス・未知の項目・空の値は拒否して保存しない", async () => {
    const { store, app } = setup();
    expect((await put(app, "/channels/unknown/secrets/channel_secret", { value: "x" })).status).toBe(404);
    expect((await put(app, "/channels/ludiars/secrets/relay_token", { value: "x" })).status).toBe(404);
    expect((await put(app, "/channels/ludiars/secrets/channel_secret", { value: "  " })).status).toBe(400);
    expect((await put(app, "/channels/ludiars/secrets/channel_secret", { value: 42 })).status).toBe(400);
    expect((await put(app, "/services/unknown/relay-token", { value: "x" })).status).toBe(404);
    expect((await put(app, "/services/mf/relay-token", { value: "x".repeat(4097) })).status).toBe(400);
    expect(store.rows.size).toBe(0);
  });
});

describe("createLineReplySender", () => {
  it("reply API へアクセストークン付きで {replyToken, messages} を送る", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const send = createLineReplySender({
      url: "https://line-api.example.test/v2/bot/message/reply",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const messages = [{ type: "text", text: "x" }];
    expect(await send({ accessToken: "access-example", reply: { replyToken: "r-1", messages } })).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://line-api.example.test/v2/bot/message/reply");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer access-example");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ replyToken: "r-1", messages });
  });

  it("失敗は投げずに結果で返す", async () => {
    const rejecting = createLineReplySender({ fetchImpl: (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch });
    expect(await rejecting({ accessToken: "a", reply: { replyToken: "r", messages: [{}] } })).toEqual({ ok: false, status: 400 });
    const failing = createLineReplySender({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await failing({ accessToken: "a", reply: { replyToken: "r", messages: [{}] } })).toEqual({ ok: false, status: null });
  });
});
