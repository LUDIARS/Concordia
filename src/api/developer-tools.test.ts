import { describe, expect, it, vi } from "vitest";
import { developerToolsRouter } from "./developer-tools.js";
import { ToolUnavailable } from "../developer-tools/contracts.js";
describe("developer tool HTTP contract", () => {
  it("rejects arbitrary operation fields before invocation", async () => {
    const execute = vi.fn();
    const app = developerToolsRouter({ execute });
    const response = await app.request("/execute", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "own", input: { operation: "tasks_list", repo: "other" } }) });
    expect(response.status).toBe(400); expect(execute).not.toHaveBeenCalled();
  });
  it("returns a preparation instruction without leaking provider errors", async () => {
    const app = developerToolsRouter({ execute: vi.fn().mockRejectedValue(new ToolUnavailable("service_stopped", "Start through Excubitor")) });
    const response = await app.request("/execute", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "own", input: { operation: "readiness" } }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, next_action: "Start through Excubitor" });
  });
  it("publishes transport alternatives without claiming a client is connected", async () => {
    const app = developerToolsRouter({ execute: vi.fn() });
    const response = await app.request("/catalog");
    const data = await response.json();
    expect(data.tools.find((tool: { operation: string }) => tool.operation === "tests_run")).toMatchObject({ transport: "CLI", mcp_required: false });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
