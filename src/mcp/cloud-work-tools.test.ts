import { describe, expect, it, vi } from "vitest";
import { executeCloudTool } from "./cloud-work-tools.js";

describe("cloud delegation MCP", () => {
  it("requires wrapper identity and forbids caller identity overrides", async () => {
    const call = vi.fn();
    await expect(executeCloudTool({ operation: "targets" }, undefined, call)).rejects.toThrow();
    await expect(executeCloudTool({ operation: "targets", session_id: "other" }, "own", call)).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
  });
  it("preserves the exact attempt ID for status and collection", async () => {
    const call = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
    await executeCloudTool({ operation: "status", attemptId: "stable-id" }, "own", call);
    expect(call).toHaveBeenLastCalledWith("GET", "/v1/delegation/cloud/runs/stable-id?session_id=own");
    await executeCloudTool({ operation: "collect", attemptId: "stable-id" }, "own", call);
    expect(call).toHaveBeenLastCalledWith("POST", "/v1/delegation/cloud/runs/stable-id/collect", { session_id: "own" });
  });
});
