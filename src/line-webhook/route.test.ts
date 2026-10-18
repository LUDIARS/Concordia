import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import type { WebSsoGate } from "../web-sso/http-gate.js";
import { MAX_LINE_WEBHOOK_BODY_BYTES } from "./route.js";
import type { LineWebhookTarget } from "./targets.js";

interface Received {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** 転送先の代役。 届いたヘッダと本文を記録し、 指定の status と本文で答える。 */
let upstream: Server;
let upstreamUrl = "";
let received: Received[] = [];
let reply: { status: number; body: string; delayMs?: number } = { status: 200, body: "ok" };

beforeEach(async () => {
  received = [];
  reply = { status: 200, body: "ok" };
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "text/plain" });
        res.end(reply.body);
      }, reply.delayMs ?? 0);
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

function appWith(targets: LineWebhookTarget[], timeoutMs?: number) {
  return makeTestApp({ webSso: denyPublic, lineWebhook: { targets: () => targets, timeoutMs } }).app;
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

describe("POST /hooks/line/:target", () => {
  it("トンネル経由 (未認証) でも通り、本文のバイト列を変えずに届ける", async () => {
    // 再直列化で崩れる形 (空白・キー順・エスケープ) を含めて、そのまま届くことを確かめる。
    const body = Buffer.from('{ "events" : [ ], "destination":"U0", "text":"\\u3042 あ" }\n', "utf8");
    const res = await appWith([mf()]).request("/hooks/line/mf", {
      method: "POST",
      headers: { ...tunnelHeaders, "content-type": "application/json; charset=utf-8", "x-line-signature": "c2ln" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(received).toHaveLength(1);
    expect(received[0]!.body.equals(body)).toBe(true);
  });

  it("Content-Type と X-Line-Signature だけを付け、cf-* / x-forwarded-* / Cookie / Authorization は付けない", async () => {
    await appWith([mf()]).request("/hooks/line/mf", {
      method: "POST",
      headers: { ...tunnelHeaders, "content-type": "application/json", "x-line-signature": "c2ln" },
      body: "{}",
    });
    const headers = received[0]!.headers;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-line-signature"]).toBe("c2ln");
    expect(Object.keys(headers).filter((name) => name.startsWith("cf-") || name.startsWith("x-forwarded-"))).toEqual([]);
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("host を指定した転送先には Host ヘッダをそれにして送る", async () => {
    await appWith([mf({ host: "mf-hook.example.test" })]).request("/hooks/line/mf", { method: "POST", body: "{}" });
    expect(received[0]!.headers.host).toBe("mf-hook.example.test");
  });

  it("host 未指定なら Host は転送先 URL のホスト", async () => {
    await appWith([mf()]).request("/hooks/line/mf", { method: "POST", body: "{}" });
    expect(received[0]!.headers.host).toBe(new URL(upstreamUrl).host);
  });

  it("転送先のステータスと本文をそのまま返す (常に 200 にしない)", async () => {
    reply = { status: 401, body: "bad signature" };
    const res = await appWith([mf()]).request("/hooks/line/mf", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("bad signature");
  });

  it("転送先がタイムアウトしたら 502", async () => {
    reply = { status: 200, body: "late", delayMs: 500 };
    const res = await appWith([mf()], 50).request("/hooks/line/mf", { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "upstream_unreachable", reason: "timeout" });
  });

  it("転送先に接続できなければ 502", async () => {
    const res = await appWith([mf({ url: "http://127.0.0.1:1/hook" })]).request("/hooks/line/mf", { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
  });

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
  });
});
