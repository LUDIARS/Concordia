import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSettingsTools } from "../src/mcp/settings-tools.js";

function setup() {
  const server = new McpServer({ name: "settings-test", version: "1" });
  const call = vi.fn(async (_method: string, _path: string, _body?: unknown) => ({
    ok: true, status: 200, body: {} as unknown,
  }));
  registerSettingsTools(server, call);
  // Match the existing core MCP test's SDK inspection boundary.
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  }> })._registeredTools;
  return { call, tools };
}

describe("settings MCP HTTP boundary", () => {
  it("passes only the supplied settings update to the existing API", async () => {
    const { call, tools } = setup();
    await tools.concordia_update_settings.handler({ updates: { example: false } });
    expect(call).toHaveBeenCalledWith("PUT", "/v1/admin/settings", { updates: { example: false } });
  });

  it("does not clear omitted team fields and encodes the target ID", async () => {
    const { call, tools } = setup();
    await tools.concordia_update_team.handler({ team_id: "a/b", rules_text: "updated" });
    expect(call).toHaveBeenCalledWith("PATCH", "/v1/teams/a%2Fb", { rules_text: "updated" });
  });

  it("rejects an empty team update before HTTP", async () => {
    const { call, tools } = setup();
    expect((await tools.concordia_update_team.handler({ team_id: "a" })).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("surfaces uncertain writes without retrying", async () => {
    const { call, tools } = setup();
    call.mockResolvedValue({ ok: false, status: 0, body: { error: "timeout" } });
    const result = await tools.concordia_update_settings.handler({ updates: { example: true } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).guidance).toContain("unknown");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
