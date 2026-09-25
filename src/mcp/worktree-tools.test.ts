import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ownWorktreeSession, registerWorktreeTools } from "./worktree-tools.js";

function setup(ownSession = vi.fn().mockResolvedValue("own-session")) {
  const server = new McpServer({ name: "worktree-test", version: "1" });
  const call = vi.fn(async (_method: string, _path: string, _body: unknown) => ({
    ok: true, status: 200, body: { cwd: "checkout" },
  }));
  registerWorktreeTools(server, call, ownSession);
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (input: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  }> })._registeredTools;
  return { call, handler: tools.concordia_create_worktree.handler };
}

describe("worktree MCP boundary", () => {
  const input = { project_code: "El", branch: "feat/new", task: "dictionary" };
  it("uses its own sidecar session even if another ID is passed to the handler", async () => {
    const { call, handler } = setup();
    await handler({ ...input, session_id: "someone-else" });
    expect(call).toHaveBeenCalledWith("POST", "/v1/implementation-tools/worktree", { ...input, session_id: "own-session" });
  });
  it("does not allocate when the caller cannot be identified", async () => {
    const { call, handler } = setup(vi.fn().mockRejectedValue(new Error("private detail")));
    expect((await handler(input)).isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });
  it("reports unknown outcomes with same-branch recovery and makes no automatic retry", async () => {
    const { call, handler } = setup();
    call.mockResolvedValue({ ok: false, status: 0, body: { cwd: "" } });
    const result = await handler(input);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).guidance).toContain("same project and branch");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("validates the sidecar address and rejects missing identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}"));
    await expect(ownWorktreeSession("0", fetchImpl)).rejects.toThrow();
    await expect(ownWorktreeSession("evil/path", fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(ownWorktreeSession("12345", fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:12345/v1/concordia/session",
      expect.objectContaining({ redirect: "error" }));
  });
});
