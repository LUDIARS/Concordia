import { describe, it, expect } from "vitest";
import { allowedChatRequest, type ChatProxyRequest } from "./actio-chat-policy.js";
import { proxyChat } from "./actio-chat-proxy.js";
import { actioChatRouter } from "../api/actio-chat.js";
const input: ChatProxyRequest = { teamId: "team", platform: "discord", workspaceId: "123456", method: "GET", path: "/guilds/123456/channels" };
describe("CC-ACTIO-CHAT-01", () => {
  it("restricts operations and destination", () => {
    expect(allowedChatRequest(input)).toBe(true);
    for (const path of ["https://attacker.example/", "/guilds/654321/channels", "/channels/123456/%2e%2e", "/users/@me/guilds"]) expect(allowedChatRequest({ ...input, path })).toBe(false);
    expect(allowedChatRequest({ ...input, method: "PATCH", path: "/guilds/123456/channels" })).toBe(false);
  });
  it("does not perform provider I/O without matching credentials", async () => {
    let calls = 0;
    const result = await proxyChat(input, { credentials: () => ({ token: "test", workspaceId: "wrong" }), request: async () => { calls++; return Response.json({}); } }, new AbortController().signal);
    expect(result.status).toBe(403); expect(calls).toBe(0);
  });
  it("requires authentication before invoking the use case", async () => {
    let calls = 0;
    const app = actioChatRouter({ secret: () => "key", credentials: () => { calls++; return null; }, review: async () => ({}) });
    expect((await app.request("/request", { method: "POST", body: JSON.stringify(input) })).status).toBe(401);
    expect(calls).toBe(0);
  });
});
