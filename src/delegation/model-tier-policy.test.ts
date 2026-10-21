import { describe, expect, it } from "vitest";
import { selectDelegationModel, type ModelQuota, type ModelCandidate } from "./model-tier-policy.js";
const candidates: ModelCandidate[] = [
  { provider: "claude", model: "claude-opus-5-5" }, { provider: "codex", model: "gpt-6-astra" },
  { provider: "claude", model: "claude-sonnet-5-5" }, { provider: "codex", model: "gpt-6.1-sol" },
  { provider: "claude", model: "claude-haiku-4-5" }, { provider: "codex", model: "gpt-6-luna" },
];
const windows = (used: number | null) => [{ used, reset: 200 }, { used, reset: 300 }];
const quota = (claude: number | null, codex: number | null): ModelQuota => ({ claude: windows(claude), codex: windows(codex) });
const select = (q: ModelQuota, provider = "claude", model = "claude-opus-5-5") =>
  selectDelegationModel({ provider, model, candidates, quota: q, nowSec: 100 });
describe("Delegation model tier allocation", () => {
  it.each([["claude", "claude-opus-5-5", "gpt-6-astra"], ["claude", "claude-sonnet-5-5", "gpt-6.1-sol"],
    ["codex", "gpt-6-astra", "claude-opus-5-5"], ["codex", "gpt-6.1-sol", "claude-sonnet-5-5"]])(
    "substitutes exhausted %s %s symmetrically", (provider, model, expected) => {
      expect(select(provider === "claude" ? quota(100, 10) : quota(10, 100), provider, model))
        .toMatchObject({ ok: true, model: expected });
    });
  it("does not call exhaustion an available slot, even if the alternate is unknown", () => {
    expect(select(quota(100, 100)).ok).toBe(false);
    expect(select(quota(100, null)).ok).toBe(false);
    expect(select(quota(null, 0))).toMatchObject({ model: "claude-opus-5-5", reason: "requested-model" });
  });
  it("honors the short and model-specific windows", () => {
    const q = quota(0, 0); q.claude = [{ used: 100, reset: 200 }, { used: 0, reset: 300 }];
    expect(select(q)).toMatchObject({ model: "gpt-6-astra" });
    expect(select({ ...quota(0, 0), opus: { used: 100, reset: 200 } })).toMatchObject({ model: "gpt-6-astra" });
  });
  it("does not use expired observations as evidence of availability", () => {
    const q = quota(100, 0); q.codex = [{ used: 0, reset: 99 }, { used: 0, reset: 300 }];
    expect(select(q).ok).toBe(false);
  });
  it.each([["ultra", "gpt-6-astra", "high"], ["high", "gpt-6.1-sol", "high"],
    ["medium", "gpt-6-luna", "high"], ["low", "gpt-6-luna", "low"]] as const)(
    "allocates level %s without crossing levels", (tier, model, effort) => {
      expect(selectDelegationModel({ provider: "claude", model: null, tier, candidates,
        quota: quota(90, 10), nowSec: 100 })).toMatchObject({ ok: true, provider: "codex", model, effort });
    });
  it("fails explicit tier selection with no known candidate and preserves local requests", () => {
    expect(selectDelegationModel({ provider: "claude", model: null, tier: "high", candidates,
      quota: quota(null, null), nowSec: 100 }).ok).toBe(false);
    expect(select(quota(100, 100), "gemma4-12", "gemma4:12b")).toMatchObject({ ok: true, provider: "gemma4-12" });
  });
});
