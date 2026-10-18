import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lineWebhookAdminRouter } from "./admin-route.js";
import {
  clearLineChannelSecret,
  describeLineChannelSecrets,
  readLineChannelSecrets,
  setLineChannelSecret,
  type LineChannelSecretStore,
} from "./channel-secrets.js";
import { buildRelayHeaders } from "./relay-headers.js";
import { parseServiceReplies } from "./replies.js";
import { createLineReplySender } from "./reply-client.js";
import { verifyLineSignature } from "./signature.js";
import type { LineWebhookTarget } from "./targets.js";

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

describe("parseServiceReplies", () => {
  const parse = (value: unknown) => parseServiceReplies(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));

  it("replies の各要素を返す (返事が無ければ空配列)", () => {
    expect(parse({ replies: [] })).toEqual([]);
    const messages = [{ type: "text", text: "おつかれさま" }];
    expect(parse({ replies: [{ replyToken: "r-1", messages }] })).toEqual([{ replyToken: "r-1", messages }]);
  });

  it("形が違えば null", () => {
    const text = { type: "text", text: "x" };
    expect(parse("not json")).toBeNull();
    expect(parse({})).toBeNull();
    expect(parse({ replies: {} })).toBeNull();
    expect(parse({ replies: [{ replyToken: "", messages: [text] }] })).toBeNull();
    expect(parse({ replies: [{ replyToken: "r", messages: [] }] })).toBeNull();
    expect(parse({ replies: [{ replyToken: "r", messages: Array(6).fill(text) }] })).toBeNull();
    expect(parse({ replies: [{ replyToken: "r", messages: ["text"] }] })).toBeNull();
  });
});

describe("buildRelayHeaders", () => {
  it("Content-Type・中継トークン・target 名・Content-Length を付け、host 指定時は Host を上書きする", () => {
    expect(buildRelayHeaders({ name: "mf", host: "mf-hook.example.test" }, "relay-token-example", 12)).toEqual({
      "content-type": "application/json",
      authorization: "Bearer relay-token-example",
      "x-concordia-line-target": "mf",
      "content-length": "12",
      host: "mf-hook.example.test",
    });
  });

  it("host 未指定なら Host を付けず、X-Line-Signature は送らない", () => {
    const headers = buildRelayHeaders({ name: "mf", host: null }, "relay-token-example", 0);
    expect(headers).not.toHaveProperty("host");
    expect(headers).not.toHaveProperty("x-line-signature");
  });
});

describe("チャネルの秘密値", () => {
  it("target ごとに保存・差し替え・消去でき、状態は真偽値だけ", () => {
    const store = memoryStore();
    expect(describeLineChannelSecrets(store, "mf")).toEqual({
      channel_secret_set: false, channel_access_token_set: false, relay_token_set: false,
    });
    setLineChannelSecret(store, "mf", "channel_secret", "s-1");
    setLineChannelSecret(store, "mf", "channel_secret", "s-2");
    setLineChannelSecret(store, "mf", "relay_token", "t-1");
    expect(readLineChannelSecrets(store, "mf")).toEqual({ channelSecret: "s-2", channelAccessToken: null, relayToken: "t-1" });
    expect(readLineChannelSecrets(store, "other").channelSecret).toBeNull();
    clearLineChannelSecret(store, "mf", "relay_token");
    expect(describeLineChannelSecrets(store, "mf")).toEqual({
      channel_secret_set: true, channel_access_token_set: false, relay_token_set: false,
    });
  });

  it("復号できない値は未設定として扱う", () => {
    const store: LineChannelSecretStore = {
      get: () => { throw new Error("cannot decrypt persisted setting"); },
      set: () => undefined,
      delete: () => undefined,
    };
    expect(readLineChannelSecrets(store, "mf").channelSecret).toBeNull();
    expect(describeLineChannelSecrets(store, "mf").channel_secret_set).toBe(false);
  });
});

describe("lineWebhookAdminRouter", () => {
  const targets: LineWebhookTarget[] = [
    { name: "mf", url: "http://192.0.2.10:8080/integrations/line/webhook", host: null, enabled: true },
  ];

  function setup() {
    const store = memoryStore();
    return { store, app: lineWebhookAdminRouter({ targets: () => targets, store }) };
  }

  it("保存した値を読み返さず、設定済みかどうかだけを返す", async () => {
    const { store, app } = setup();
    const put = await app.request("/targets/mf/secrets/channel_secret", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: " s-example " }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain("s-example");
    expect(store.rows.get("line_webhook.mf.channel_secret")).toBe("s-example");

    const list = await app.request("/targets");
    const text = await list.text();
    expect(text).not.toContain("s-example");
    expect(JSON.parse(text)).toEqual({
      targets: [{ name: "mf", enabled: true, channel_secret_set: true, channel_access_token_set: false, relay_token_set: false }],
    });
  });

  it("消去すると未設定に戻る", async () => {
    const { store, app } = setup();
    setLineChannelSecret(store, "mf", "relay_token", "t-example");
    const res = await app.request("/targets/mf/secrets/relay_token", { method: "DELETE" });
    expect(await res.json()).toMatchObject({ ok: true, relay_token_set: false });
    expect(store.rows.size).toBe(0);
  });

  it("未登録の target・未知の項目・空の値は拒否して保存しない", async () => {
    const { store, app } = setup();
    const send = (path: string, value: unknown) => app.request(path, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    expect((await send("/targets/unknown/secrets/channel_secret", "x")).status).toBe(404);
    expect((await send("/targets/mf/secrets/password", "x")).status).toBe(404);
    expect((await send("/targets/mf/secrets/channel_secret", "  ")).status).toBe(400);
    expect((await send("/targets/mf/secrets/channel_secret", 42)).status).toBe(400);
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
