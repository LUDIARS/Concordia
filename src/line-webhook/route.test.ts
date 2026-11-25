import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { relayToLineTestUpstream, type LineTestUpstream } from "../../tests/helpers/line-webhook-upstream.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import type { WebSsoGate } from "../web-sso/http-gate.js";
import type { LineChannelSecrets } from "./channel-secrets.js";
import type { LineReplyOutcome, LineReplyRequest } from "./reply-client.js";
import { MAX_LINE_WEBHOOK_BODY_BYTES, type LineWebhookLog } from "./route.js";
import { MemoryLineTalkLinkStore } from "./talk-links.js";
import type { LineWebhookTarget } from "./targets.js";

/** テスト値 (実物ではない)。 */
const CHANNEL_SECRET = "example-channel-secret";
const ACCESS_TOKEN = "example-access-token";
const RELAY_TOKENS: Record<string, string> = { mf: "example-relay-token-mf", mm: "example-relay-token-mm" };
const GROUP = "C0000000000000000000000000000000a";
const sign = (body: string | Buffer) => createHmac("sha256", CHANNEL_SECRET).update(body).digest("base64");
const say = (text: string) => [{ type: "text", text }];

function testUpstream(service: string): LineTestUpstream {
  return {
    url: `http://${service}.example.test/integrations/line/webhook`,
    received: [],
    answer: () => ({ status: 200, body: { replies: [] } }),
  };
}

let mfUp: LineTestUpstream;
let mmUp: LineTestUpstream;
let replyCalls: LineReplyRequest[] = [];
let replyOutcome: () => Promise<LineReplyOutcome> = async () => ({ ok: true });
let logged: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
let links: MemoryLineTalkLinkStore;
let onReplyFailure: (() => void) | undefined;

beforeEach(() => {
  replyCalls = [];
  logged = [];
  replyOutcome = async () => ({ ok: true });
  onReplyFailure = undefined;
  links = new MemoryLineTalkLinkStore();
  mfUp = testUpstream("mf");
  mmUp = testUpstream("mm");
});

function nextReplyFailure(): Promise<void> {
  return new Promise((resolve) => { onReplyFailure = resolve; });
}

/** 公開ホストの要求は全部拒否するゲート (cf-ray の付いた要求 = トンネル由来を想定)。 */
const denyPublic: WebSsoGate = {
  decide: async (header) => header("cf-ray")
    ? { kind: "deny", status: 401, reason: "login required" }
    : { kind: "local" },
  close: () => undefined,
};

const captureLog: LineWebhookLog = {
  info: (fields, message) => { logged.push({ level: "info", fields, message }); },
  warn: (fields, message) => {
    logged.push({ level: "warn", fields, message });
    if (message === "line reply failed") {
      onReplyFailure?.();
      onReplyFailure = undefined;
    }
  },
};

const mf = (overrides: Partial<LineWebhookTarget> = {}): LineWebhookTarget => ({
  name: "mf", url: mfUp.url, host: null, enabled: true, channel: "ludiars", keywords: ["おてつだい"], ...overrides,
});
const mm = (overrides: Partial<LineWebhookTarget> = {}): LineWebhookTarget => ({
  name: "mm", url: mmUp.url, host: null, enabled: true, channel: "ludiars", keywords: ["メモリア"], ...overrides,
});

interface AppOptions {
  secrets?: Partial<LineChannelSecrets>;
  relayTokens?: Record<string, string | null>;
  relayFailure?: "timeout" | "connect";
}

function appWith(targets: LineWebhookTarget[], options: AppOptions = {}) {
  const secrets = { channelSecret: CHANNEL_SECRET, channelAccessToken: ACCESS_TOKEN, ...options.secrets };
  const relayTokens = { ...RELAY_TOKENS, ...options.relayTokens };
  return makeTestApp({
    webSso: denyPublic,
    lineWebhook: {
      targets: () => targets,
      secrets: () => secrets,
      relayToken: (service) => relayTokens[service] ?? null,
      talkLinks: links,
      sendReply: (request) => { replyCalls.push(request); return replyOutcome(); },
      relay: async (input) => {
        if (options.relayFailure) return { kind: "unreachable", reason: options.relayFailure };
        const upstream = [mfUp, mmUp].find((target) => target.url === input.url);
        if (!upstream) throw new Error(`Unexpected test relay destination: ${input.url}`);
        return relayToLineTestUpstream(input, upstream);
      },
      log: captureLog,
      now: () => 1000,
    },
  }).app;
}

const tunnelHeaders = {
  "cf-ray": "8f00000000000000-NRT",
  "cf-connecting-ip": "198.51.100.7",
  "x-forwarded-for": "198.51.100.7",
  "x-forwarded-proto": "https",
  cookie: "__Host-cc-sso=t",
  authorization: "Bearer should-not-leak",
};

const textEvent = (text: string, replyToken = "reply-token-1", groupId = GROUP) => ({
  type: "message", replyToken, source: { type: "group", groupId, userId: "U0" }, message: { type: "text", id: "1", text },
});

/** 正しい署名付きで LINE からの webhook を送る。 */
function deliver(
  app: ReturnType<typeof appWith>,
  events: unknown[] | string = [],
  extra: Record<string, string> = {},
  channel = "ludiars",
) {
  const body = typeof events === "string" ? events : JSON.stringify({ destination: "U-bot", events });
  return app.request(`/hooks/line/${channel}`, {
    method: "POST",
    headers: { ...tunnelHeaders, "content-type": "application/json; charset=utf-8", "x-line-signature": sign(body), ...extra },
    body,
  });
}

describe("POST /hooks/line/:channel — 署名の検証", () => {
  it("署名が一致すればトンネル経由 (未認証) でも通る", async () => {
    links.link("ludiars", GROUP, "mf", 1);
    const res = await deliver(appWith([mf(), mm()]), [textEvent("ただいま")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mfUp.received).toHaveLength(1);
  });

  it("署名が一致しなければ 401 で、サービスへ送らない", async () => {
    const app = appWith([mf()]);
    const wrong = await deliver(app, [textEvent("おてつだい")], { "x-line-signature": sign("{}") });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "signature_rejected" });
    const missing = await app.request("/hooks/line/ludiars", { method: "POST", body: "{}" });
    expect(missing.status).toBe(401);
    expect(mfUp.received).toEqual([]);
    expect(replyCalls).toEqual([]);
  });

  it("チャネルシークレット未設定なら 503 で、サービスへ送らない", async () => {
    const res = await deliver(appWith([mf()], { secrets: { channelSecret: null } }), [textEvent("おてつだい")]);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "line_channel_not_configured" });
    expect(mfUp.received).toEqual([]);
  });

  it("署名の通った本文に events 配列が無ければ 400", async () => {
    const res = await deliver(appWith([mf()]), '{"destination":"U-bot"}');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
  });
});

describe("POST /hooks/line/:channel — 振り分けと転送", () => {
  it("呼びかけの言葉で始まる発言はそのサービスだけへ、受けた形 ({destination, events}) のまま送る", async () => {
    links.link("ludiars", GROUP, "mf", 1);
    const event = textEvent("メモリア きょうのこと");
    await deliver(appWith([mf(), mm()]), [event]);
    expect(mfUp.received).toEqual([]);
    expect(mmUp.received).toHaveLength(1);
    expect(mmUp.received[0]!.body).toEqual({ destination: "U-bot", events: [event] });
  });

  it("中継トークン・サービス名・チャネル名を付け、X-Line-Signature / cf-* / x-forwarded-* / Cookie は送らない", async () => {
    const res = await deliver(appWith([mf(), mm()]), [textEvent("おてつだい")]);
    expect(res.status).toBe(200);
    expect(mfUp.received).toHaveLength(1);
    const headers = mfUp.received[0]!.headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe(`Bearer ${RELAY_TOKENS.mf}`);
    expect(headers["x-concordia-line-target"]).toBe("mf");
    expect(headers["x-concordia-line-channel"]).toBe("ludiars");
    expect(headers["x-line-signature"]).toBeUndefined();
    expect(Object.keys(headers).filter((name) => name.startsWith("cf-") || name.startsWith("x-forwarded-"))).toEqual([]);
    expect(headers.cookie).toBeUndefined();
  });

  it("host を指定したサービスには Host ヘッダをそれにして送る", async () => {
    const res = await deliver(appWith([mf({ host: "mf-hook.example.test" })]), [textEvent("おてつだい")]);
    expect(res.status).toBe(200);
    expect(mfUp.received).toHaveLength(1);
    expect(mfUp.received[0]!.headers.host).toBe("mf-hook.example.test");
  });

  it("言葉の無い発言はそのトークのふだんの相手だけへ", async () => {
    links.link("ludiars", GROUP, "mm", 1);
    links.link("ludiars", GROUP, "mf", 2);
    await deliver(appWith([mf(), mm()]), [textEvent("ただいま")]);
    expect(mfUp.received).toEqual([]);
    expect(mmUp.received).toHaveLength(1);
  });

  it("紐付けの無いトークの、言葉の無い発言は誰にも回さず 200 {}", async () => {
    const res = await deliver(appWith([mf(), mm()]), [textEvent("ただいま")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(mfUp.received).toEqual([]);
    expect(mmUp.received).toEqual([]);
  });

  it("イベントが無い (LINE の検証ボタン) なら誰にも回さず 200 {}", async () => {
    const res = await deliver(appWith([mf()]), []);
    expect(res.status).toBe(200);
    expect(mfUp.received).toEqual([]);
  });

  it("channel の無い既存の mf 行は /hooks/line/mf で受ける (後方互換)", async () => {
    const legacy = mf({ channel: "mf", keywords: [] });
    links.link("mf", GROUP, "mf", 1);
    const res = await deliver(appWith([legacy]), [textEvent("ただいま")], {}, "mf");
    expect(res.status).toBe(200);
    expect(mfUp.received).toHaveLength(1);
    expect(mfUp.received[0]!.headers["x-concordia-line-channel"]).toBe("mf");
  });
});

describe("POST /hooks/line/:channel — つなぐ", () => {
  it("全サービスへ回し、linked を返したサービスをつなぎ、初めてならふだんの相手にする", async () => {
    mmUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-1", messages: say("つながりました") }], linked: true } });
    mfUp.answer = () => ({ status: 200, body: { replies: [] } });
    const res = await deliver(appWith([mf(), mm()]), [textEvent("つなぐ １２３４")]);
    expect(res.status).toBe(200);
    expect(mfUp.received).toHaveLength(1);
    expect(mmUp.received).toHaveLength(1);
    expect(links.forTalk("ludiars", GROUP)).toEqual([{ service: "mm", isDefault: true }]);
    expect(replyCalls).toEqual([{ accessToken: ACCESS_TOKEN, reply: { replyToken: "reply-token-1", messages: say("つながりました") } }]);
  });

  it("2 つ目につながったサービスはふだんの相手にならない", async () => {
    links.link("ludiars", GROUP, "mm", 1);
    mfUp.answer = () => ({ status: 200, body: { replies: [], linked: true } });
    await deliver(appWith([mf(), mm()]), [textEvent("つなぐ 99")]);
    expect(links.forTalk("ludiars", GROUP)).toEqual([
      { service: "mm", isDefault: true },
      { service: "mf", isDefault: false },
    ]);
  });

  it("「つなぐ」でない本文への linked は記録しない、unlinked は紐付けを消す", async () => {
    links.link("ludiars", GROUP, "mm", 1);
    mfUp.answer = () => ({ status: 200, body: { replies: [], linked: true } });
    await deliver(appWith([mf(), mm()]), [textEvent("おてつだい")]);
    expect(links.forTalk("ludiars", GROUP)).toEqual([{ service: "mm", isDefault: true }]);
    mmUp.answer = () => ({ status: 200, body: { replies: [], unlinked: true } });
    await deliver(appWith([mf(), mm()]), [textEvent("ただいま")]);
    expect(links.forTalk("ludiars", GROUP)).toEqual([]);
  });
});

describe("POST /hooks/line/:channel — postback", () => {
  it("返信の postback data を cc:<サービス>: で包んで送り、押されたら外してそのサービスへ回す", async () => {
    mmUp.answer = () => ({ status: 200, body: { replies: [{
      replyToken: "reply-token-1",
      messages: [{ type: "template", altText: "x", template: { type: "buttons", text: "どれ", actions: [{ type: "postback", label: "できた", data: "done=1" }] } }],
    }] } });
    await deliver(appWith([mf(), mm()]), [textEvent("メモリア")]);
    const template = replyCalls[0]!.reply.messages[0]!.template as { actions: Array<{ data: string }> };
    expect(template.actions[0]!.data).toBe("cc:mm:done=1");

    const pressed = { type: "postback", replyToken: "reply-token-2", source: { type: "group", groupId: GROUP }, postback: { data: "cc:mm:done=1" } };
    await deliver(appWith([mf(), mm()]), [pressed]);
    expect(mmUp.received).toHaveLength(2);
    expect((mmUp.received[1]!.body.events as Array<{ postback: unknown }>)[0]!.postback).toEqual({ data: "done=1" });
    expect(mfUp.received).toEqual([]);
  });

  it("包みの無い postback はどのサービスにも回さない", async () => {
    links.link("ludiars", GROUP, "mf", 1);
    const pressed = { type: "postback", replyToken: "reply-token-2", source: { type: "group", groupId: GROUP }, postback: { data: "done=1" } };
    const res = await deliver(appWith([mf(), mm()]), [pressed]);
    expect(res.status).toBe(200);
    expect(mfUp.received).toEqual([]);
    expect(mmUp.received).toEqual([]);
  });

  it("包むと 300 文字を超える data の返信は包まずに送り、ログに残す", async () => {
    const long = "x".repeat(299);
    mfUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-1", messages: [{ type: "postback", data: long }] }] } });
    await deliver(appWith([mf()]), [textEvent("おてつだい")]);
    expect(replyCalls[0]!.reply.messages[0]!.data).toBe(long);
    expect(logged.some((entry) => entry.level === "warn" && entry.message.startsWith("line postback data too long"))).toBe(true);
  });
});

describe("POST /hooks/line/:channel — 退出と参加", () => {
  const member = (type: string) => ({ type, source: { type: "group", groupId: GROUP } });

  it("leave はつながっていた全サービスへ回し、そのトークの記録を消す", async () => {
    links.link("ludiars", GROUP, "mf", 1);
    links.link("ludiars", GROUP, "mm", 2);
    await deliver(appWith([mf(), mm()]), [member("leave")]);
    expect(mfUp.received).toHaveLength(1);
    expect(mmUp.received).toHaveLength(1);
    expect(links.list()).toEqual([]);
  });

  it("memberJoined / memberLeft はつながっているサービスだけへ", async () => {
    links.link("ludiars", GROUP, "mf", 1);
    await deliver(appWith([mf(), mm()]), [member("memberJoined"), member("memberLeft")]);
    expect(mfUp.received).toHaveLength(1);
    expect((mfUp.received[0]!.body.events as unknown[])).toHaveLength(2);
    expect(mmUp.received).toEqual([]);
    expect(links.list()).toHaveLength(1);
  });

  it("join は全サービスへ回し、同じ replyToken の返信を設定順に合流する (5 件超は捨ててログ)", async () => {
    const join = { type: "join", replyToken: "reply-token-join", source: { type: "group", groupId: GROUP } };
    mfUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-join", messages: [...say("mf-1"), ...say("mf-2"), ...say("mf-3")] }] } });
    mmUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-join", messages: [...say("mm-1"), ...say("mm-2"), ...say("mm-3")] }] } });
    const res = await deliver(appWith([mf(), mm()]), [join]);
    expect(res.status).toBe(200);
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0]!.reply.messages.map((message) => message.text)).toEqual(["mf-1", "mf-2", "mf-3", "mm-1", "mm-2"]);
    expect(logged.some((entry) => entry.message.includes("over the limit") && entry.fields.dropped === 1)).toBe(true);
  });
});

describe("POST /hooks/line/:channel — LINE への応答", () => {
  const join = { type: "join", replyToken: "reply-token-join", source: { type: "group", groupId: GROUP } };

  it("一部の回し先が失敗しても 1 つ成功すれば 200 で、成功した方の返信だけを送る", async () => {
    mfUp.answer = () => ({ status: 503, body: { error: "integration_not_configured" } });
    mmUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-join", messages: say("mm です") }] } });
    const res = await deliver(appWith([mf(), mm()]), [join]);
    expect(res.status).toBe(200);
    expect(replyCalls.map((call) => call.reply.messages)).toEqual([say("mm です")]);
  });

  it("回し先が全部失敗したら 502 で、返信しない", async () => {
    mfUp.answer = () => ({ status: 401, body: { error: "relay_token_rejected" } });
    mmUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "r", messages: [] }] } });
    const res = await deliver(appWith([mf(), mm()]), [join]);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_failed" });
    expect(replyCalls).toEqual([]);
  });

  it("タイムアウト・接続失敗・中継トークン未設定は失敗として数える", async () => {
    const timeout = await deliver(appWith([mf()], { relayFailure: "timeout" }), [textEvent("おてつだい")]);
    expect(timeout.status).toBe(502);
    const unreachable = await deliver(appWith([mf()], { relayFailure: "connect" }), [textEvent("おてつだい")]);
    expect(unreachable.status).toBe(502);
    const before = mfUp.received.length;
    const noToken = await deliver(appWith([mf()], { relayTokens: { mf: null } }), [textEvent("おてつだい")]);
    expect(noToken.status).toBe(502);
    expect(mfUp.received.length).toBe(before);
  });

  it("返信が失敗しても例外でも LINE への 200 は変えない", async () => {
    mfUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-1", messages: say("おかえり") }] } });
    let finishReply!: (outcome: LineReplyOutcome) => void;
    const pendingReply = new Promise<LineReplyOutcome>((resolve) => { finishReply = resolve; });
    replyOutcome = () => pendingReply;
    const firstFailure = nextReplyFailure();
    expect((await deliver(appWith([mf()]), [textEvent("おてつだい")])).status).toBe(200);
    finishReply({ ok: false, status: 400 });
    await firstFailure;

    replyOutcome = async () => { throw new Error("offline"); };
    const secondFailure = nextReplyFailure();
    expect((await deliver(appWith([mf()]), [textEvent("おてつだい")])).status).toBe(200);
    await secondFailure;
    expect(logged.filter((entry) => entry.message === "line reply failed")).toHaveLength(2);
  });

  it("チャネルアクセストークン未設定なら 200 で、返信しない", async () => {
    mfUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-1", messages: say("おかえり") }] } });
    const res = await deliver(appWith([mf()], { secrets: { channelAccessToken: null } }), [textEvent("おてつだい")]);
    expect(res.status).toBe(200);
    expect(replyCalls).toEqual([]);
  });
});

describe("POST /hooks/line/:channel — ログ", () => {
  it("ログに秘密値・本文・署名・replyToken を出さない", async () => {
    const events = [textEvent("おてつだい ひみつの合言葉", "reply-token-secret")];
    const body = JSON.stringify({ destination: "U-bot", events });
    mfUp.answer = () => ({ status: 200, body: { replies: [{ replyToken: "reply-token-secret", messages: say("おかえり") }] } });
    replyOutcome = async () => ({ ok: false, status: 500 });
    const failure = nextReplyFailure();
    await deliver(appWith([mf()]), events);
    await failure;
    await deliver(appWith([mf()], { secrets: { channelAccessToken: null } }), events);
    await deliver(appWith([mf()]), events, { "x-line-signature": "d3Jvbmc=" });
    const text = JSON.stringify(logged);
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of [
      CHANNEL_SECRET, ACCESS_TOKEN, RELAY_TOKENS.mf!, "ひみつの合言葉", sign(body), "d3Jvbmc=", "reply-token-secret", "おかえり", GROUP,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("POST /hooks/line/:channel — 受け口", () => {
  it("未登録・無効のチャネルは 404 で、転送しない", async () => {
    const app = appWith([mf({ enabled: false }), mm({ channel: "other" })]);
    expect((await app.request("/hooks/line/ludiars", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/hooks/line/unknown", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/hooks/line/other/extra", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/hooks/line", { method: "POST", body: "{}" })).status).toBe(404);
    expect(mfUp.received).toEqual([]);
  });

  it("POST 以外のメソッドは 404 (トンネル経由でも認証画面へ落とさない)", async () => {
    const app = appWith([mf()]);
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await app.request("/hooks/line/ludiars", { method, headers: tunnelHeaders })).status).toBe(404);
    }
    expect(mfUp.received).toEqual([]);
  });

  it("本文が 1 MB を超えたら 413 で、転送しない", async () => {
    const res = await appWith([mf()]).request("/hooks/line/ludiars", {
      method: "POST",
      body: Buffer.alloc(MAX_LINE_WEBHOOK_BODY_BYTES + 1, 0x20),
    });
    expect(res.status).toBe(413);
    expect(mfUp.received).toEqual([]);
  });

  it("他の経路は今まで通り公開側で認証を要求する", async () => {
    const app = appWith([mf()]);
    expect((await app.request("/health", { headers: tunnelHeaders })).status).toBe(401);
    expect((await app.request("/v1/sessions", { headers: tunnelHeaders })).status).toBe(401);
    expect((await app.request("/hooks/other", { method: "POST", headers: tunnelHeaders })).status).toBe(401);
    expect((await app.request("/v1/admin/line-webhook/channels", { headers: tunnelHeaders })).status).toBe(401);
  });
});
