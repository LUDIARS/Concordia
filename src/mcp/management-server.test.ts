import { describe, expect, it, vi } from "vitest";
import { buildManagementServer, createManagementCaller } from "./management-server.js";

describe("management MCP server", () => {
  it("exposes only the six dots operations (CC-MGMT-INV-01)", () => {
    const server = buildManagementServer(vi.fn());
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(tools).toEqual([
      "acknowledge_management_changes",
      "get_management_request",
      "read_management_changes",
      "read_management_context",
      "record_management_decision",
      "submit_management_request",
    ]);
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
