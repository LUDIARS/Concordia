import { describe, expect, it, vi } from "vitest";
import { callOrbisTool, type OrbisConnection } from "./mcp-client.js";
import { OrbisError, publicOrbisError } from "./errors.js";
import { parseOrbisRequest } from "./request.js";

// Fixed dummy token only. This fetch implements the MCP protocol without opening a socket.
const connection: OrbisConnection = { url: "http://127.0.0.1:25001/", instanceId: "cc-instance", clientId: "session-a", token: "d".repeat(43) };
const request = parseOrbisRequest("read", { sigillum: "human-seal" });
function peer(tool: (args: Record<string, unknown>, headers: Headers) => unknown = () => ({ content: [{ type: "text", text: "page text" }] })) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-orbis", version: "1" } }
      : tool(message.params, new Headers(init?.headers));
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
}

describe("Orbis Streamable HTTP adapter", () => {
  it("sends the three shared headers and exact tool payload on every request, then aborts transport", async () => {
    const fetchImpl = peer((args, headers) => {
      expect(headers.get("authorization")).toBe(`Bearer ${connection.token}`);
      expect(headers.get("x-orbis-client-id")).toBe("session-a");
      expect(headers.get("x-orbis-instance-id")).toBe("cc-instance");
      expect(args).toEqual({ name: "orbis_read", arguments: { sigillum: "human-seal", mode: "text" } });
      return { content: [{ type: "text", text: "page text" }] };
    });
    expect(await callOrbisTool(request, connection, { fetchImpl })).toMatchObject({ content: [{ text: "page text" }] });
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toBe(connection.url);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${connection.token}`);
      expect(init?.redirect).toBe("error");
      expect(init?.signal?.aborted).toBe(true);
    }
  });
  it.each([401, 403])("maps HTTP %s to unauthorized without exposing a response body", async status => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`private ${connection.token}`, { status }));
    await expect(callOrbisTool(request, connection, { fetchImpl })).rejects.toThrow(/^orbis_unauthorized$/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("maps unavailable connections and enforces a deadline without retries", async () => {
    const unavailable = vi.fn<typeof fetch>(async () => { throw new TypeError(`private ${connection.token}`); });
    await expect(callOrbisTool(request, connection, { fetchImpl: unavailable })).rejects.toThrow(/^orbis_unavailable$/);
    const hanging = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(callOrbisTool(request, connection, { fetchImpl: hanging, timeoutMs: 15 })).rejects.toThrow(/^orbis_unavailable$/);
    // SDK may emit a cancellation notification; it must never resend the initialize request.
    expect(hanging.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === "initialize")).toHaveLength(1);
    expect(hanging.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("does not leak tool failure text or tokens", async () => {
    const fetchImpl = peer(() => ({ isError: true, content: [{ type: "text", text: `https://private/?token=${connection.token}` }] }));
    await expect(callOrbisTool(request, connection, { fetchImpl })).rejects.toThrow(/^orbis_operation_failed$/);
    expect(publicOrbisError(new Error(`private ${connection.token}`))).toBe("orbis_operation_failed");
    expect(publicOrbisError(new OrbisError("orbis_token_missing"))).toBe("orbis_token_missing");
  });
  it("forwards stable client identity so the peer rejects another session's seal", async () => {
    const fetchImpl = peer((_args, headers) => headers.get("x-orbis-client-id") === "session-a"
      ? { content: [{ type: "text", text: "allowed" }] }
      : { isError: true, content: [{ type: "text", text: "Sigillum is not attached by this client." }] });
    await expect(callOrbisTool(request, connection, { fetchImpl })).resolves.toMatchObject({ content: [{ text: "allowed" }] });
    await expect(callOrbisTool(request, { ...connection, clientId: "session-b" }, { fetchImpl })).rejects.toThrow(/^orbis_operation_failed$/);
  });
});
