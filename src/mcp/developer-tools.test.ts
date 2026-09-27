import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDeveloperTools } from "./developer-tools.js";
import { DEVELOPER_TOOLS } from "../developer-tools/catalog.js";

function fixture() {
  const server = new McpServer({ name: "test", version: "1" });
  const call = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
  const own = vi.fn(async () => "own-session");
  registerDeveloperTools(server, call, own);
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;
  }> })._registeredTools;
  return { call, own, tools };
}
describe("common command MCP tools", () => {
  it("publishes each declared operation and calls the same HTTP contract", async () => {
    const { tools, call } = fixture();
    for (const tool of DEVELOPER_TOOLS) expect(tools[`concordia_${tool.operation}`]).toBeDefined();
    await tools.concordia_task_get.handler({ reference: "actio:1" });
    expect(call).toHaveBeenCalledWith("POST", "/v1/developer-tools/execute", {
      session_id: "own-session", input: { operation: "task_get", reference: "actio:1" },
    });
  });
  it("cannot impersonate another session on branch switching", async () => {
    const { tools, call } = fixture();
    await tools.concordia_switch_branch.handler({ project_code: "Cc", branch: "feat/tools", task: "tools", session_id: "other" });
    expect(call).toHaveBeenCalledWith("POST", "/v1/implementation-tools/switch", expect.objectContaining({ session_id: "own-session" }));
  });
  it("does not send mutations without its sidecar", async () => {
    const { tools, call, own } = fixture();
    own.mockRejectedValue(new Error("not connected"));
    expect((await tools.concordia_task_update.handler({ reference: "actio:1", status: "done" })).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
  it("sends Bash to the harness action envelope", async () => {
    const { tools, call } = fixture();
    await tools.concordia_check_bash.handler({ command: "git status", cwd: "/repo", branch: "feat/tools" });
    expect(call).toHaveBeenCalledWith("POST", "/v1/harness/gate", { session_id: "own-session",
      action: { tool: "Bash", command: "git status", cwd: "/repo", branch: "feat/tools" } });
  });
});
