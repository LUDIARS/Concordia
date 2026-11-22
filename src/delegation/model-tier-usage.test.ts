// vitest.config.ts は isolate:false なので module registry がファイル間で共有される。
// 先に別ファイルが本物の依存で読んだ実装が残っていると、この file の vi.mock が効かず
// 本物の使用量取得や CLI 起動が走る (全体実行でだけ落ちる)。各テストで resetModules して
// import し直し、この file の mock 実体だけを見るようにする (context-report.test.ts と同じ形)。
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../auth/anthropic-oauth-usage.js", () => ({ fetchClaudeOAuthUsage: vi.fn() }));
vi.mock("../cost/codex-rate-limits.js", async importOriginal => ({
  ...await importOriginal<typeof import("../cost/codex-rate-limits.js")>(), fetchCodexRateLimits: vi.fn(), codexRateObservationTime: vi.fn(() => 1000),
}));
let fetchClaudeOAuthUsage: typeof import("../auth/anthropic-oauth-usage.js")["fetchClaudeOAuthUsage"];
let fetchCodexRateLimits: typeof import("../cost/codex-rate-limits.js")["fetchCodexRateLimits"];
let mapRateLimitsToCostRate: typeof import("../cost/codex-rate-limits.js")["mapRateLimitsToCostRate"];
let collectDelegationModelQuota: typeof import("./model-tier-usage.js")["collectDelegationModelQuota"];
let collectModelQuotaSnapshot: typeof import("./model-tier-usage.js")["collectModelQuotaSnapshot"];
let selectDelegationModel: typeof import("./model-tier-policy.js")["selectDelegationModel"];
beforeEach(async () => {
  vi.resetModules();
  ({ fetchClaudeOAuthUsage } = await import("../auth/anthropic-oauth-usage.js"));
  ({ fetchCodexRateLimits, mapRateLimitsToCostRate } = await import("../cost/codex-rate-limits.js"));
  ({ collectDelegationModelQuota, collectModelQuotaSnapshot } = await import("./model-tier-usage.js"));
  ({ selectDelegationModel } = await import("./model-tier-policy.js"));
});
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
