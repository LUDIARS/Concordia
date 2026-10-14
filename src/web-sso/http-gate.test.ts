import type { IncomingMessage } from "node:http";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { GateDecision } from "./gate.js";
import { webSsoAllowsUpgrade, webSsoMiddleware, type WebSsoGate } from "./http-gate.js";

function gateReturning(decision: GateDecision, seen: { allowLogin?: boolean; host?: string } = {}): WebSsoGate {
  return {
    decide: async (header, allowLogin) => {
      seen.allowLogin = allowLogin;
      seen.host = header("host") ?? undefined;
      return decision;
    },
    close: () => undefined,
  };
}

function appWith(gate: WebSsoGate): Hono {
  const app = new Hono();
  app.use("*", webSsoMiddleware(gate));
  app.get("/", (c) => c.text("ok"));
  return app;
}

const session = { userId: "u1", projectKey: "concordia", organizationId: "org", organizationRole: "admin", expiresAt: 0 };

describe("webSsoMiddleware", () => {
  it("公開側でなければそのまま通す", async () => {
    const res = await appWith(gateReturning({ kind: "local" })).request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("通すときは発行した Cookie を応答に付ける", async () => {
    const seen: { allowLogin?: boolean } = {};
    const res = await appWith(gateReturning({ kind: "allow", session, setCookie: "__Host-cc-sso=t" }, seen)).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBe("__Host-cc-sso=t");
    expect(seen.allowLogin).toBe(true);
  });

  it("拒否はハンドラを呼ばず status を返し、キャッシュさせない", async () => {
    const res = await appWith(gateReturning({ kind: "deny", status: 503, reason: "down", setCookie: "__Host-cc-sso=; Max-Age=0" })).request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("down");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("webSsoAllowsUpgrade", () => {
  const req = { headers: { host: "cc.example.com" } } as unknown as IncomingMessage;

  it("login させずに判定し、拒否なら status を返す", async () => {
    const seen: { allowLogin?: boolean; host?: string } = {};
    expect(await webSsoAllowsUpgrade(gateReturning({ kind: "deny", status: 401, reason: "x" }, seen), req))
      .toEqual({ ok: false, status: 401 });
    expect(seen).toEqual({ allowLogin: false, host: "cc.example.com" });
  });

  it("通す判定と公開側でない判定は upgrade を許す", async () => {
    expect(await webSsoAllowsUpgrade(gateReturning({ kind: "allow", session }), req)).toEqual({ ok: true });
    expect(await webSsoAllowsUpgrade(gateReturning({ kind: "local" }), req)).toEqual({ ok: true });
  });
});
