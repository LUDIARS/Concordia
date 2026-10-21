import { expect, it, vi } from "vitest";
vi.mock("../auth/anthropic-oauth-usage.js", () => ({ fetchClaudeOAuthUsage: vi.fn() }));
vi.mock("../cost/codex-rate-limits.js", () => ({ fetchCodexRateLimits: vi.fn() }));
import { fetchClaudeOAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits } from "../cost/codex-rate-limits.js";
import { collectDelegationModelQuota } from "./model-tier-usage.js";
it("retains unknown usage rather than inventing availability", async () => {
  vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(null);
  vi.mocked(fetchCodexRateLimits).mockResolvedValue({ used5h: 100, usedWeekly: 5,
    reset5hAt: 200, resetWeeklyAt: 300, plan: null });
  expect(await collectDelegationModelQuota()).toEqual({
    claude: [{ used: null, reset: null }, { used: null, reset: null }],
    codex: [{ used: 100, reset: 200 }, { used: 5, reset: 300 }], opus: null, sonnet: null,
  });
});
