import { describe, expect, it, vi } from "vitest";
import type { DelegationRepo } from "../db/delegation-repo.js";
import { internalAgentSelectionRouter } from "./internal-agent-selection.js";
const row = { call_name: "sonnet", is_active: 1, target_provider: "claude", model: "claude-sonnet-5" };
const usage = () => Promise.resolve({ codexWeekly: null, claudeWeekly: null, fableUsedPct: null });
const request = (body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });
describe("internal Agent selection API", () => {
  it("returns the exact configured model without invoking a provider", async () => {
    const repo = { listTemplates: vi.fn(() => [row]) } as unknown as Pick<DelegationRepo, "listTemplates">;
    const app = internalAgentSelectionRouter(repo, usage);
    const response = await app.request("/", request(JSON.stringify({ prompt: "README typo" })));
    expect(response.status).toBe(200);
    expect((await response.json()).selection).toMatchObject({ call_name: "sonnet", model: "claude-sonnet-5", reasoning_effort: "low" });
  });
  it("rejects malformed input before collecting usage", async () => {
    const collect = vi.fn(usage);
    const app = internalAgentSelectionRouter({ listTemplates: () => [] }, collect);
    expect((await app.request("/", request("{}"))).status).toBe(400);
    expect((await app.request("/", request("invalid"))).status).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });
  it("returns unavailable for missing candidates", async () => {
    const app = internalAgentSelectionRouter({ listTemplates: () => [] }, usage);
    expect((await app.request("/", request(JSON.stringify({ prompt: "fix" })))).status).toBe(503);
  });
});
