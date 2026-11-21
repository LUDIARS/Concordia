import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildManagementServer, createManagementCaller } from "./management-server.js";

describe("management MCP server", () => {
  it("exposes only the dots operations (CC-MGMT-INV-01)", () => {
    const server = buildManagementServer(vi.fn());
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(tools).toEqual([
      "acknowledge_management_changes",
      "evaluate_management_request",
      "get_management_request",
      "read_management_changes",
      "read_management_context",
      "record_management_decision",
      "submit_management_request",
    ]);
  });

  it("uses the dots evaluation endpoint and encodes the request key", async () => {
    const call = vi.fn(async () => ({ ok: true, status: 200, body: { request: { state: "effect_confirmed" } } }));
    const server = buildManagementServer(call);
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: "evaluate_management_request", arguments: {
        key: "variant/1:#x", action: "effect_confirmed", evidence_seqs: [7],
      } });
      expect(call).toHaveBeenCalledWith("POST", "/v1/management/requests/variant%2F1%3A%23x/evaluate", {
        action: "effect_confirmed", evidence_seqs: [7],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends the mission token and reports lost responses as result_unknown", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const call = createManagementCaller("http://cc.test/", "tok", fetchImpl as unknown as typeof fetch);
    expect(await call("GET", "/v1/management/context")).toEqual({ ok: true, status: 200, body: { ok: true } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://cc.test/v1/management/context");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");

    const failing = createManagementCaller("http://cc.test", "tok", vi.fn(async () => { throw new Error("reset"); }) as unknown as typeof fetch);
    expect(await failing("POST", "/v1/management/requests", {})).toMatchObject({ ok: false, status: 0, body: { error: "result_unknown" } });
  });
});

describe("management MCP client with a Cloudflare service token (CC-MGMT-08)", () => {
  it("adds the service token headers only when configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await createManagementCaller("https://cdgd-mgmt.example", "tok", fetchImpl as unknown as typeof fetch,
      { clientId: "id", clientSecret: "secret" })("GET", "/v1/management/context");
    const headers = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["cf-access-client-id"]).toBe("id");
    expect(headers["cf-access-client-secret"]).toBe("secret");
    expect(headers.authorization).toBe("Bearer tok");
  });
});
