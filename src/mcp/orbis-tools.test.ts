import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executeOrbisTool, registerOrbisTools } from "./orbis-tools.js";

describe("Orbis session MCP tools", () => {
  it("registers just the eight requested operations", () => {
    const server = new McpServer({ name: "test", version: "1" });
    const register = vi.spyOn(server, "registerTool");
    registerOrbisTools(server, vi.fn(), () => "session-a");
    expect(register.mock.calls.map(args => args[0])).toEqual([
      "orbis_attach", "orbis_detach", "orbis_open", "orbis_navigate", "orbis_read", "orbis_act", "orbis_logs", "orbis_reveal",
    ]);
  });
  it("inherits wrapper identity and refuses an identity override", async () => {
    const call = vi.fn(async () => ({ ok: true, status: 200, body: { content: [] } }));
    await executeOrbisTool("read", { sigillum: "s" }, "session-a", call);
    expect(call).toHaveBeenCalledWith("POST", "/v1/orbis/read", { session_id: "session-a", sigillum: "s", mode: "text" });
    call.mockClear();
    await expect(executeOrbisTool("attach", { sigillum: "s", session_id: "session-b" }, "session-a", call)).rejects.toThrow("orbis_invalid_request");
    await expect(executeOrbisTool("attach", { sigillum: "s" }, undefined, call)).rejects.toThrow("orbis_unauthorized");
    expect(call).not.toHaveBeenCalled();
  });
  it("preserves only the closed error vocabulary from HTTP", async () => {
    const call = vi.fn(async () => ({ ok: false, status: 500, body: { error: "https://private/?token=secret" } }));
    await expect(executeOrbisTool("read", { sigillum: "s" }, "live", call)).rejects.toThrow(/^orbis_operation_failed$/);
  });
});
