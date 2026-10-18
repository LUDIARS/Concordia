import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import type { WebSsoGate } from "../web-sso/http-gate.js";
import type { LineChannelSecrets } from "./channel-secrets.js";
import type { LineReplyOutcome, LineReplyRequest } from "./reply-client.js";
import { MAX_LINE_WEBHOOK_BODY_BYTES, type LineWebhookLog } from "./route.js";
import type { LineWebhookTarget } from "./targets.js";

interface Received {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const CHANNEL_SECRET = "example-channel-secret";
const ACCESS_TOKEN = "example-access-token";
const RELAY_TOKEN = "example-relay-token";
const sign = (body: string | Buffer) => createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64");
const TEXT = [{ type: "text", text: "おかえり" }];

/** 転送先 (サービス) の代役。 届いたヘッダと本文を記録し、 指定の status と本文で答える。 */
let upstream: Server;
let upstreamUrl = "";
let received: Received[] = [];
let answer: { status: number; body: string; delayMs?: number } = { status: 200, body: "" };
/** LINE reply API の代役に届いた呼び出し。 */
let replyCalls: LineReplyRequest[] = [];
let replyOutcome: () => Promise<LineReplyOutcome> = async () => ({ ok: true });
let logged: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];

beforeEach(async () => {
  received = [];
  replyCalls = [];
  logged = [];
  replyOutcome = async () => ({ ok: true });
  answer = { status: 200, body: JSON.stringify({ replies: [{ replyToken: "reply-token-1", messages: TEXT }] }) };
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      setTimeout(() => {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/integrations/line/webhook`;
});

afterEach(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** 公開ホストの要求は全部拒否するゲート (cf-ray の付いた要求 = トンネル由来を想定)。 */
const denyPublic: WebSsoGate = {
  decide: async (header) => header("cf-ray")
    ? { kind: "deny", status: 401, reason: "login required" }
    : { kind: "local" },
  close: () => undefined,
};

const allSecrets: LineChannelSecrets = { channelSecret: CHANNEL_SECRET, channelAccessToken: ACCESS_TOKEN, relayToken: RELAY_TOKEN };

const captureLog: LineWebhookLog = {
  info: (fields, message) => { logged.push({ level: "info", fields, message }); },
  warn: (fields, message) => { logged.push({ level: "warn", fields, message }); },
};

function appWith(targets: LineWebhookTarget[], options: { secrets?: Partial<LineChannelSecrets>; timeoutMs?: number } = {}) {
  const secrets = { ...allSecrets, ...options.secrets };
  return makeTestApp({
    webSso: denyPublic,
    lineWebhook: {
      targets: () => targets,
      secrets: () => secrets,
      sendReply: (request) => { replyCalls.push(request); return replyOutcome(); },
      timeoutMs: options.timeoutMs,
      log: captureLog,
    },
  }).app;
}

function mf(overrides: Partial<LineWebhookTarget> = {}): LineWebhookTarget {
  return { name: "mf", url: upstreamUrl, host: null, enabled: true, ...overrides };
}

const tunnelHeaders = {
  "cf-ray": "8f00000000000000-NRT",
  "cf-connecting-ip": "198.51.100.7",
  "x-forwarded-for": "198.51.100.7",
  "x-forwarded-proto": "https",
  cookie: "__Host-cc-sso=t",
  authorization: "Bearer should-not-leak",
};

/** 正しい署名付きで LINE からの webhook を送る。 */
function deliver(app: ReturnType<typeof appWith>, body: string | Buffer = '{"events":[]}', extra: Record<string, string> = {}) {
  return app.request("/hooks/line/mf", {
    method: "POST",
    headers: { ...tunnelHeaders, "content-type": "application/json; charset=utf-8", "x-line-signature": sign(body), ...extra },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });
}

/** 返信は LINE への応答の後で走るので、 少し待つ。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("POST /hooks/line/:target — 署名の検証", () => {
  it("署名が一致すればトンネル経由 (未認証) でも通り、本文のバイト列を変えずに届ける", async () => {
    // 再直列化で崩れる形 (空白・キー順・エスケープ) を含めて、そのまま届くことを確かめる。
    const body = Buffer.from('{ "events" : [ ], "destination":"U0", "text":"\\u3042 あ" }\n', "utf8");
    const res = await deliver(appWith([mf()]), body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(received).toHaveLength(1);
    expect(received[0]!.body.equals(body)).toBe(true);
  });

  it("署名が一致しなければ 401 で、サービスへ送らない", async () => {
    const app = appWith([mf()]);
    const wrong = await deliver(app, '{"events":[]}', { "x-line-signature": sign('{"events":[1]}') });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "signature_rejected" });
    const missing = await app.request("/hooks/line/mf", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(received).toEqual([]);
    expect(replyCalls).toEqual([]);
  });

  it("チャネルシークレット未設定なら 503 で、サービスへ送らない", async () => {
    const res = await deliver(appWith([mf()], { secrets: { channelSecret: null } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "line_channel_not_configured" });
    expect(received).toEqual([]);
  });

  it("中継トークン未設定でも 503 で、サービスへ送らない", async () => {
    const res = await deliver(appWith([mf()], { secrets: { relayToken: null } }));
    expect(res.status).toBe(503);
    expect(received).toEqual([]);
  });
});

describe("POST /hooks/line/:target — 転送", () => {
  it("中継トークン・target 名・Content-Type を付け、X-Line-Signature / cf-* / x-forwarded-* / Cookie は送らない", async () => {
    await deliver(appWith([mf()]));
    const headers = received[0]!.headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(`Bearer ${RELAY_TOKEN}`);
    expect(headers["x-concordia-line-target"]).toBe("mf");
    expect(headers["x-line-signature"]).toBeUndefined();
    expect(Object.keys(headers).filter((name) => name.startsWith("cf-") || name.startsWith("x-forwarded-"))).toEqual([]);
    expect(headers.cookie).toBeUndefined();
  });

  it("host を指定した転送先には Host ヘッダをそれにして送る", async () => {
    await deliver(appWith([mf({ host: "mf-hook.example.test" })]));
    expect(received[0]!.headers.host).toBe("mf-hook.example.test");
  });

  it("host 未指定なら Host は転送先 URL のホスト", async () => {
    await deliver(appWith([mf()]));
    expect(received[0]!.headers.host).toBe(new URL(upstreamUrl).host);
  });
});

describe("POST /hooks/line/:target — LINE への返信", () => {
  it("サービスが 2xx なら 200 を返し、replies をチャネルアクセストークン付きで reply API へ送る", async () => {
    const res = await deliver(appWith([mf()]));
    expect(res.status).toBe(200);
    await settle();
    expect(replyCalls).toEqual([{ accessToken: ACCESS_TOKEN, reply: { replyToken: "reply-token-1", messages: TEXT } }]);
  });

  it("返事が無ければ ({replies: []}) 200 で、返信しない", async () => {
    answer = { status: 200, body: JSON.stringify({ replies: [] }) };
    expect((await deliver(appWith([mf()]))).status).toBe(200);
    await settle();
    expect(replyCalls).toEqual([]);
  });

  it("返信が失敗しても LINE への 200 は変えない", async () => {
    replyOutcome = async () => ({ ok: false, status: 400 });
    const res = await deliver(appWith([mf()]));
    expect(res.status).toBe(200);
    await settle();
    expect(replyCalls).toHaveLength(1);
    expect(logged.some((entry) => entry.level === "warn" && entry.message === "line reply failed")).toBe(true);
  });

  it("返信が例外で落ちても 200 のまま", async () => {
    replyOutcome = async () => { throw new Error("offline"); };
    expect((await deliver(appWith([mf()]))).status).toBe(200);
    await settle();
    expect(logged.some((entry) => entry.message === "line reply failed")).toBe(true);
  });

  it("チャネルアクセストークン未設定なら 200 で、返信しない", async () => {
    const res = await deliver(appWith([mf()], { secrets: { channelAccessToken: null } }));
    expect(res.status).toBe(200);
    await settle();
    expect(replyCalls).toEqual([]);
  });

  for (const status of [401, 503]) {
    it(`サービスが ${status} なら 502 で、返信しない`, async () => {
      answer = { status, body: JSON.stringify({ error: "relay_token_rejected" }) };
      const res = await deliver(appWith([mf()]));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "upstream_failed", status });
      await settle();
      expect(replyCalls).toEqual([]);
    });
  }

  it("サービスの応答 JSON の形が違えば 502 で、返信しない", async () => {
    answer = { status: 200, body: JSON.stringify({ replies: [{ replyToken: "r", messages: [] }] }) };
    const res = await deliver(appWith([mf()]));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_failed", status: 200 });
    await settle();
    expect(replyCalls).toEqual([]);
  });

  it("サービスがタイムアウトしたら 502 (status は null)", async () => {
    answer = { status: 200, body: JSON.stringify({ replies: [] }), delayMs: 500 };
    const res = await deliver(appWith([mf()], { timeoutMs: 50 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_failed", status: null });
  });

  it("サービスに接続できなければ 502", async () => {
    const res = await deliver(appWith([mf({ url: "http://127.0.0.1:1/hook" })]));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_failed", status: null });
  });
});

describe("POST /hooks/line/:target — ログ", () => {
  it("ログに秘密値・本文・署名を出さない", async () => {
    const body = '{"events":[{"type":"message","message":{"text":"ひみつの合言葉"}}]}';
    replyOutcome = async () => ({ ok: false, status: 500 });
    await deliver(appWith([mf()]), body);
    await deliver(appWith([mf()], { secrets: { channelAccessToken: null } }), body);
    await deliver(appWith([mf()]), body, { "x-line-signature": "d3Jvbmc=" });
    await settle();
    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [CHANNEL_SECRET, ACCESS_TOKEN, RELAY_TOKEN, "ひみつの合言葉", sign(body), "d3Jvbmc=", "reply-token-1", "おかえり"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("POST /hooks/line/:target — 受け口", () => {
  it("未登録・無効の target は 404 で、転送しない", async () => {
    const app = appWith([mf({ enabled: false })]);
    expect((await app.request("/hooks/line/mf", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/hooks/line/unknown", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/hooks/line/mf/extra", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/hooks/line", { method: "POST", body: "{}" })).status).toBe(404);
    expect(received).toEqual([]);
  });

  it("POST 以外のメソッドは 404 (トンネル経由でも認証画面へ落とさない)", async () => {
    const app = appWith([mf()]);
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await app.request("/hooks/line/mf", { method, headers: tunnelHeaders })).status).toBe(404);
    }
    expect(received).toEqual([]);
  });

  it("本文が 1 MB を超えたら 413 で、転送しない", async () => {
    const res = await appWith([mf()]).request("/hooks/line/mf", {
      method: "POST",
      body: Buffer.alloc(MAX_LINE_WEBHOOK_BODY_BYTES + 1, 0x20),
    });
    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  it("他の経路は今まで通り公開側で認証を要求する", async () => {
    const app = appWith([mf()]);
    expect((await app.request("/health", { headers: tunnelHeaders })).status).toBe(401);
    expect((await app.request("/v1/sessions", { headers: tunnelHeaders })).status).toBe(401);
    expect((await app.request("/hooks/other", { method: "POST", headers: tunnelHeaders })).status).toBe(401);
    expect((await app.request("/v1/admin/line-webhook/targets", { headers: tunnelHeaders })).status).toBe(401);
  });
});
