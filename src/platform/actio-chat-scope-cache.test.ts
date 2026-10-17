import { describe, expect, it } from "vitest";
import { createChatScopeCache } from "./actio-chat-scope-cache.js";
import { proxyChat } from "./actio-chat-proxy.js";
import type { ChatProxyRequest } from "./actio-chat-policy.js";

const post: ChatProxyRequest = { teamId: "team", platform: "discord", workspaceId: "123456", method: "POST", path: "/channels/424242/messages", body: { content: "hi" } };

function discordFake(guild = "123456") {
  const calls: string[] = [];
  const request = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/channels/424242")) return Response.json({ guild_id: guild });
    return Response.json({ id: "m1" });
  }) as typeof fetch;
  return { calls, request };
}

describe("CC-ACTIO-CHAT-02 scope cache", () => {
  it("verifies a Discord channel once and reuses the verified guild", async () => {
    const fake = discordFake();
    const deps = { credentials: () => ({ token: "t", workspaceId: "123456" }), request: fake.request, scopeCache: createChatScopeCache() };
    expect((await proxyChat(post, deps, new AbortController().signal)).status).toBe(200);
    expect((await proxyChat(post, deps, new AbortController().signal)).status).toBe(200);
    expect(fake.calls.filter(u => u.endsWith("/channels/424242"))).toHaveLength(1);
    expect(fake.calls.filter(u => u.endsWith("/messages"))).toHaveLength(2);
  });

  it("still rejects a cached channel that belongs to another guild", async () => {
    const fake = discordFake("999");
    const deps = { credentials: () => ({ token: "t", workspaceId: "123456" }), request: fake.request, scopeCache: createChatScopeCache() };
    expect((await proxyChat(post, deps, new AbortController().signal)).status).toBe(403);
    expect((await proxyChat(post, deps, new AbortController().signal)).status).toBe(403);
    expect(fake.calls.some(u => u.endsWith("/messages"))).toBe(false);
  });

  it("does not remember a failed check", async () => {
    let fail = true;
    const calls: string[] = [];
    const request = (async (url: string | URL | Request) => {
      const u = String(url); calls.push(u);
      if (u.endsWith("/channels/424242")) return fail ? new Response("{}", { status: 503 }) : Response.json({ guild_id: "123456" });
      return Response.json({ id: "m1" });
    }) as typeof fetch;
    const deps = { credentials: () => ({ token: "t", workspaceId: "123456" }), request, scopeCache: createChatScopeCache() };
    expect((await proxyChat(post, deps, new AbortController().signal)).status).toBe(503);
    fail = false;
    expect((await proxyChat(post, deps, new AbortController().signal)).status).toBe(200);
    expect(calls.filter(u => u.endsWith("/channels/424242"))).toHaveLength(2);
  });

  it("separates entries by token and expires them after the TTL", () => {
    let t = 0;
    const cache = createChatScopeCache({ ttlMs: 1000, now: () => t });
    cache.set("discord", "a", "42", "g1");
    expect(cache.get("discord", "a", "42")).toBe("g1");
    expect(cache.get("discord", "b", "42")).toBeUndefined();
    t = 1000;
    expect(cache.get("discord", "a", "42")).toBeUndefined();
  });

  it("caches the Slack workspace identity per token", async () => {
    const calls: string[] = [];
    const request = (async (url: string | URL | Request) => {
      const u = String(url); calls.push(u);
      if (u.endsWith("auth.test")) return Response.json({ ok: true, team_id: "T1" });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const input: ChatProxyRequest = { teamId: "team", platform: "slack", workspaceId: "T1", method: "POST", path: "chat.postMessage", body: { channel: "C1", text: "hi" } };
    const deps = { credentials: () => ({ token: "x" }), request, scopeCache: createChatScopeCache() };
    expect((await proxyChat(input, deps, new AbortController().signal)).status).toBe(200);
    expect((await proxyChat(input, deps, new AbortController().signal)).status).toBe(200);
    expect(calls.filter(u => u.endsWith("auth.test"))).toHaveLength(1);
  });
});
