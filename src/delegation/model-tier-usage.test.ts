import { expect, it, vi } from "vitest";
vi.mock("../auth/anthropic-oauth-usage.js", () => ({ fetchClaudeOAuthUsage: vi.fn() }));
vi.mock("../cost/codex-rate-limits.js", async importOriginal => ({
  ...await importOriginal<typeof import("../cost/codex-rate-limits.js")>(), fetchCodexRateLimits: vi.fn(), codexRateObservationTime: vi.fn(() => 1000),
}));
import { fetchClaudeOAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits, mapRateLimitsToCostRate } from "../cost/codex-rate-limits.js";
import { collectDelegationModelQuota, collectModelQuotaSnapshot } from "./model-tier-usage.js";
import { selectDelegationModel } from "./model-tier-policy.js";
it("retains unknown usage rather than inventing availability", async () => {
  vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(null);
  vi.mocked(fetchCodexRateLimits).mockResolvedValue({ used5h: 100, usedWeekly: 5,
    reset5hAt: 200, resetWeeklyAt: 300, plan: null });
  expect(await collectDelegationModelQuota()).toEqual({
    claude: [{ used: null, reset: null }, { used: null, reset: null }],
    codex: [{ used: 100, reset: 200 }, { used: 5, reset: 300 }], opus: null, sonnet: null,
  });
});
it.each([
  ["claude-sonnet-5-5", "gpt-6.1-sol"], ["claude-opus-5-5", "gpt-6-astra"],
])("substitutes exhausted %s using the real weekly-only Codex response", async (model, replacement) => {
  vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(null);
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(mapRateLimitsToCostRate({ rateLimits: {
    primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 300 }, secondary: null,
  } }));
  const q = await collectDelegationModelQuota();
  expect(q.codex).toEqual([{ used: 30, reset: 300 }]);
  expect(selectDelegationModel({ provider: "claude", model, nowSec: 100,
    candidates: [{ provider: "codex", model: replacement }],
    quota: { ...q, claude: [{ used: null, reset: null }, { used: 100, reset: 300 }] },
  })).toMatchObject({ ok: true, provider: "codex", model: replacement });
});
it("does not discard an unknown window without explicit absence evidence", async () => {
  vi.mocked(fetchCodexRateLimits).mockResolvedValue(mapRateLimitsToCostRate({ rateLimits: {
    primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 300 }, secondary: {},
  } }));
  expect((await collectDelegationModelQuota()).codex).toEqual([
    { used: null, reset: null }, { used: 30, reset: 300 },
  ]);
});

it("preserves observation timestamps instead of making unknown Claude fresh", async () => {
  vi.mocked(fetchClaudeOAuthUsage).mockResolvedValue(null);
  expect((await collectModelQuotaSnapshot()).observedAt).toEqual({ claude: null, codex: 1000 });
});
