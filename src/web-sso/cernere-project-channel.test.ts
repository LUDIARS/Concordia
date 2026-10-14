import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { CernereProjectChannel, CernereRejectedError, CernereUnavailableError } from "./cernere-project-channel.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** Cernere の /ws/project を真似る。token を記録し、module_request に onRequest の結果で答える。 */
async function fakeCernere(onRequest: (msg: Record<string, unknown>, ws: WebSocket) => void): Promise<{ url: string; tokens: string[] }> {
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws/project" });
  const tokens: string[] = [];
  wss.on("connection", (ws, req) => {
    tokens.push(new URL(req.url ?? "", "http://x").searchParams.get("token") ?? "");
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (msg.type === "module_request") onRequest(msg, ws);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokens };
}

function loginFetch(token = "project-jwt", status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ accessToken: token, expiresIn: 3600 }), { status }));
}

function channelFor(url: string, fetchImpl: ReturnType<typeof loginFetch>, timeoutMs = 2_000): CernereProjectChannel {
  const channel = new CernereProjectChannel({
    cernereUrl: url, clientId: "cid", clientSecret: "secret", timeoutMs, fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  cleanups.push(() => channel.close());
  return channel;
}

describe("CernereProjectChannel", () => {
  it("project_credentials で token を取り、request_id で応答を対応付ける", async () => {
    const cernere = await fakeCernere((msg, ws) => {
      ws.send(JSON.stringify({ type: "module_response", request_id: msg.request_id, module: msg.module, action: msg.action, payload: { echo: msg.payload } }));
    });
    const fetchImpl = loginFetch();
    const channel = channelFor(cernere.url, fetchImpl);

    await expect(channel.request("enterprise", "verify", { enterpriseToken: "t" })).resolves.toEqual({ echo: { enterpriseToken: "t" } });
    await expect(channel.request("enterprise", "verify", { enterpriseToken: "u" })).resolves.toEqual({ echo: { enterpriseToken: "u" } });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${cernere.url}/api/auth/login`);
    expect(JSON.parse(String(init?.body))).toEqual({ grant_type: "project_credentials", client_id: "cid", client_secret: "secret" });
    expect(cernere.tokens).toEqual(["project-jwt"]);
  });

  it("Cernere の error 応答は CernereRejectedError", async () => {
    const cernere = await fakeCernere((msg, ws) => {
      ws.send(JSON.stringify({ type: "error", request_id: msg.request_id, code: "command_error", message: "expired" }));
    });
    const channel = channelFor(cernere.url, loginFetch());
    await expect(channel.request("enterprise", "verify", {})).rejects.toBeInstanceOf(CernereRejectedError);
  });

  it("答えが無ければ時間切れで CernereUnavailableError", async () => {
    const cernere = await fakeCernere(() => undefined);
    const channel = channelFor(cernere.url, loginFetch(), 100);
    await expect(channel.request("enterprise", "verify", {})).rejects.toBeInstanceOf(CernereUnavailableError);
  });

  it("project login が通らなければ CernereUnavailableError", async () => {
    const cernere = await fakeCernere(() => undefined);
    const channel = channelFor(cernere.url, loginFetch("x", 401));
    await expect(channel.request("enterprise", "verify", {})).rejects.toBeInstanceOf(CernereUnavailableError);
  });

  it("ping には pong を返す", async () => {
    const pongs: unknown[] = [];
    const cernere = await fakeCernere((msg, ws) => {
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        if (m.type === "pong") pongs.push(m.ts);
      });
      ws.send(JSON.stringify({ type: "ping", ts: 42 }));
      setTimeout(() => ws.send(JSON.stringify({ type: "module_response", request_id: msg.request_id, payload: null })), 50);
    });
    const channel = channelFor(cernere.url, loginFetch());
    await channel.request("enterprise", "verify", {});
    expect(pongs).toEqual([42]);
  });
});
