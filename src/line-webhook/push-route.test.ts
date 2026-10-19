import { beforeEach, describe, expect, it } from "vitest";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import type { WebSsoGate } from "../web-sso/http-gate.js";
import { lineWebhookAdminRouter } from "./admin-route.js";
import type { LineChannelSecrets, LineChannelSecretStore } from "./channel-secrets.js";
import type { LinePushOutcome, LinePushRequest } from "./push-client.js";
import { PushLedger, PUSH_RATE_LIMIT } from "./push-limits.js";
import { derivePushRetryKey } from "./push-retry-key.js";
import { hashPushToken, readPushEnabled, readPushTokenHash } from "./push-token.js";
import type { LineWebhookLog } from "./route.js";
import { MemoryLineTalkLinkStore } from "./talk-links.js";
import type { LineWebhookTarget } from "./targets.js";

/** テスト値 (実物ではない)。 */
const PUSH_TOKEN = "example-push-token";
const ACCESS_TOKEN = "example-access-token";
const GROUP = "C0000000000000000000000000000000a";
const USER = "U0000000000000000000000000000000b";

const target = (name: string, overrides: Partial<LineWebhookTarget> = {}): LineWebhookTarget => ({
  name, url: `http://127.0.0.1:9/${name}`, host: null, enabled: true, channel: "ludiars", keywords: [], ...overrides,
});

/** 公開ホストの要求は全部拒否するゲート (cf-ray の付いた要求 = トンネル由来を想定)。 */
const denyPublic: WebSsoGate = {
  decide: async (header) => header("cf-ray")
    ? { kind: "deny", status: 401, reason: "login required" }
    : { kind: "local" },
  close: () => undefined,
};

let pushCalls: LinePushRequest[];
let pushOutcome: (request: LinePushRequest) => LinePushOutcome;
let logged: Array<{ fields: Record<string, unknown>; message: string }>;
let links: MemoryLineTalkLinkStore;

beforeEach(() => {
  pushCalls = [];
  pushOutcome = () => ({ ok: true });
  logged = [];
  links = new MemoryLineTalkLinkStore();
  links.link("ludiars", GROUP, "mf", 1);
  links.link("ludiars", USER, "mf", 1);
});

const captureLog: LineWebhookLog = {
  info: (fields, message) => { logged.push({ fields, message }); },
  warn: (fields, message) => { logged.push({ fields, message }); },
};

interface AppOptions {
  targets?: LineWebhookTarget[];
  tokenHash?: string | null;
  enabled?: boolean;
  secrets?: Partial<LineChannelSecrets>;
  ledger?: PushLedger;
}

function appWith(options: AppOptions = {}) {
  const secrets = { channelSecret: "example-channel-secret", channelAccessToken: ACCESS_TOKEN, ...options.secrets };
  const tokenHash = options.tokenHash === undefined ? hashPushToken(PUSH_TOKEN) : options.tokenHash;
  return makeTestApp({
    webSso: denyPublic,
    lineWebhook: {
      targets: () => options.targets ?? [target("mf"), target("mm")],
      secrets: () => secrets,
      talkLinks: links,
      log: captureLog,
      now: () => 1000,
      push: {
        tokenHash: () => tokenHash,
        enabled: () => options.enabled ?? true,
        ledger: options.ledger ?? new PushLedger(),
        sendPush: async (request) => { pushCalls.push(request); return pushOutcome(request); },
      },
    },
  }).app;
}

function push(
  app: ReturnType<typeof appWith>,
  body: unknown = { requestId: "req-1", messages: [{ text: "おてつだいが 1 つ終わりました" }] },
  { path = "/hooks/line/ludiars/push/mf", token = PUSH_TOKEN as string | null } = {},
) {
  return app.request(path, {
    method: "POST",
    headers: {
      "cf-ray": "8f00000000000000-NRT",
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /hooks/line/:channel/push/:service — 送信", () => {
  it("ふだんの相手にしているトーク全部へ、 トークごとの Retry-Key で送る (SSO を通さない)", async () => {
    links.link("ludiars", "C-mm-only", "mm", 1);
    links.link("ludiars", GROUP, "mm", 1); // mm はこのグループのふだんの相手ではない
    const res = await push(appWith());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 0 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(pushCalls.map((call) => call.to).sort()).toEqual([GROUP, USER].sort());
    for (const call of pushCalls) {
      expect(call.accessToken).toBe(ACCESS_TOKEN);
      expect(call.texts).toEqual(["おてつだいが 1 つ終わりました"]);
      expect(call.retryKey).toBe(derivePushRetryKey("ludiars", "mf", "req-1", call.to));
    }
  });

  it("送り先が無ければ送らずに sent 0", async () => {
    const res = await push(appWith(), undefined, { path: "/hooks/line/ludiars/push/mm" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0 });
    expect(pushCalls).toHaveLength(0);
  });

  it("LINE の 429 などは再送せず failed に数える。 ログは status と件数だけ", async () => {
    pushOutcome = (request) => request.to === GROUP ? { ok: false, status: 429 } : { ok: true };
    const res = await push(appWith());
    expect(await res.json()).toEqual({ sent: 1, failed: 1 });
    expect(pushCalls).toHaveLength(2);
    const text = JSON.stringify(logged);
    expect(text).toContain("429");
    for (const secret of [GROUP, USER, PUSH_TOKEN, ACCESS_TOKEN, "おてつだい", "req-1"]) expect(text).not.toContain(secret);
  });

  it("同じ requestId は送らずに前回の結果を返す (別の requestId は送る)", async () => {
    const app = appWith();
    expect(await (await push(app)).json()).toEqual({ sent: 2, failed: 0 });
    const again = await push(app);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ sent: 2, failed: 0 });
    expect(pushCalls).toHaveLength(2);
    await push(app, { requestId: "req-2", messages: [{ text: "つぎ" }] });
    expect(pushCalls).toHaveLength(4);
  });

  it("1 サービス 1 分 10 件を超えると 429 rate_limited で送らない", async () => {
    const app = appWith();
    for (let i = 0; i < PUSH_RATE_LIMIT; i++) {
      expect((await push(app, { requestId: `req-${i}`, messages: [{ text: "a" }] })).status).toBe(200);
    }
    const res = await push(app, { requestId: "req-over", messages: [{ text: "a" }] });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(pushCalls).toHaveLength(PUSH_RATE_LIMIT * 2);
  });
});

describe("POST /hooks/line/:channel/push/:service — 拒否", () => {
  it("未登録・無効・別チャネルのサービスは 404", async () => {
    const app = appWith({ targets: [target("mf"), target("mm", { enabled: false }), target("other", { channel: "other" })] });
    expect((await push(app, undefined, { path: "/hooks/line/ludiars/push/none" })).status).toBe(404);
    expect((await push(app, undefined, { path: "/hooks/line/ludiars/push/mm" })).status).toBe(404);
    expect((await push(app, undefined, { path: "/hooks/line/ludiars/push/other" })).status).toBe(404);
    expect((await app.request("/hooks/line/ludiars/push/mf", { method: "GET" })).status).toBe(404);
    expect(pushCalls).toHaveLength(0);
  });

  it("push トークン未発行は 503、 不一致・欠落は 401", async () => {
    const unissued = await push(appWith({ tokenHash: null }));
    expect(unissued.status).toBe(503);
    expect(await unissued.json()).toEqual({ error: "push_token_not_configured" });
    expect((await push(appWith(), undefined, { token: "wrong-token" })).status).toBe(401);
    expect((await push(appWith(), undefined, { token: null })).status).toBe(401);
    expect(pushCalls).toHaveLength(0);
  });

  it("pushEnabled が false なら 403 push_disabled で送らない", async () => {
    const res = await push(appWith({ enabled: false }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "push_disabled" });
    expect(pushCalls).toHaveLength(0);
  });

  it("本文の形違いは 400、 大きすぎる本文は 413", async () => {
    expect((await push(appWith(), "{not json")).status).toBe(400);
    expect((await push(appWith(), { requestId: "req-1", messages: [] })).status).toBe(400);
    expect((await push(appWith(), "x".repeat(70 * 1024))).status).toBe(413);
    expect(pushCalls).toHaveLength(0);
  });

  it("チャネルアクセストークン未設定は 503 で送らない", async () => {
    const res = await push(appWith({ secrets: { channelAccessToken: null } }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "line_channel_not_configured" });
    expect(pushCalls).toHaveLength(0);
  });

  it("webhook の受け口はそのまま (push の口以外の入れ子のパスは 404)", async () => {
    const res = await appWith().request("/hooks/line/ludiars/other/mf", { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("管理 API — push トークンと pushEnabled", () => {
  function memoryStore(): LineChannelSecretStore & { rows: Map<string, string> } {
    const rows = new Map<string, string>();
    return {
      rows,
      get: (key) => rows.get(key) ?? null,
      set: (key, value) => { rows.set(key, value); },
      delete: (key) => { rows.delete(key); },
    };
  }

  function adminWith(store: LineChannelSecretStore) {
    return lineWebhookAdminRouter({
      targets: () => [target("mf")],
      store,
      talkLinks: new MemoryLineTalkLinkStore(),
      readTargetsSetting: () => null,
      writeTargetsSetting: () => undefined,
    });
  }

  it("発行は平文を一度だけ返し、 一覧には発行済みかどうかと pushEnabled だけが出る", async () => {
    const store = memoryStore();
    const admin = adminWith(store);
    const before = await (await admin.request("/services")).json() as { services: Array<Record<string, unknown>> };
    expect(before.services[0]).toMatchObject({ name: "mf", push_token_set: false, push_enabled: false });

    const issued = await admin.request("/services/mf/push-token", { method: "POST" });
    expect(issued.status).toBe(200);
    const { push_token: token } = await issued.json() as { push_token: string };
    expect(readPushTokenHash(store, "mf")).toBe(hashPushToken(token));
    expect([...store.rows.values()]).not.toContain(token);

    const listed = await admin.request("/services");
    const text = await listed.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text).services[0]).toMatchObject({ push_token_set: true, push_enabled: false });
  });

  it("pushEnabled の切り替えとトークンの消去 (戻し方)", async () => {
    const store = memoryStore();
    const admin = adminWith(store);
    await admin.request("/services/mf/push-token", { method: "POST" });
    const put = (body: unknown) => admin.request("/services/mf/push-enabled", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await put({ enabled: true })).status).toBe(200);
    expect(readPushEnabled(store, "mf")).toBe(true);
    expect((await put({ enabled: "yes" })).status).toBe(400);
    expect((await put({ enabled: false })).status).toBe(200);
    expect(readPushEnabled(store, "mf")).toBe(false);
    expect((await admin.request("/services/mf/push-token", { method: "DELETE" })).status).toBe(200);
    expect(readPushTokenHash(store, "mf")).toBeNull();
    expect((await admin.request("/services/none/push-token", { method: "POST" })).status).toBe(404);
    expect((await admin.request("/services/none/push-enabled", { method: "PUT", body: "{}" })).status).toBe(404);
  });
});
