/** @implements spec/feature/delegation-model-tiers.md DMT-01..04 */
export const MODEL_TIERS = ["ultra", "high", "medium", "low"] as const;
export type ModelTier = typeof MODEL_TIERS[number];
export type ModelFamily = "claude" | "codex";
export interface QuotaObservation { used: number | null; reset: number | null }
export interface ModelQuota {
  claude: readonly QuotaObservation[];
  codex: readonly QuotaObservation[];
  opus?: QuotaObservation | null;
  sonnet?: QuotaObservation | null;
}
export interface ModelCandidate { provider: ModelFamily; model: string }
export type ModelSelection = { ok: true; provider: string; model: string | null;
  effort?: string; reason: string } | { ok: false; error: string };

export function modelRole(model: string | null): string | null {
  return model?.toLowerCase().match(/(?:^|[-/])(opus|astra|sonnet|sol|haiku|luna)(?:$|[-/])/)?.[1] ?? null;
}
export function modelTier(model: string | null): ModelTier | null {
  const role = modelRole(model);
  return role === "opus" || role === "astra" ? "ultra"
    : role === "sonnet" || role === "sol" ? "high"
      : role === "haiku" || role === "luna" ? "medium" : null;
}
/** Every applicable window must be known; adapters omit only proven absent windows. */
function remaining(candidate: ModelCandidate, quota: ModelQuota, now: number): number | null {
  const common = quota[candidate.provider];
  const role = modelRole(candidate.model);
  const scoped = role === "opus" ? quota.opus : role === "sonnet" ? quota.sonnet : null;
  const values = [...common, ...(scoped ? [scoped] : [])].map(w =>
    w.used === null || !Number.isFinite(w.used) || w.used < 0 || w.used > 100
      || (w.reset !== null && w.reset <= now) ? null : 100 - w.used);
  if (values.includes(0)) return 0;
  if (common.length === 0 || values.includes(null)) return null;
  return Math.min(...values as number[]);
}

export function selectDelegationModel(input: {
  provider: string; model: string | null; tier?: ModelTier;
  candidates: readonly ModelCandidate[]; quota: ModelQuota; nowSec: number;
}): ModelSelection {
  const family = input.provider === "codex-sdk" ? "codex" : input.provider;
  const unchanged = { ok: true as const, provider: input.provider, model: input.model, reason: "requested-model" };
  if (family !== "claude" && family !== "codex") {
    return input.tier ? { ok: false, error: "model_tier_unsupported_provider" } : unchanged;
  }
  const tier = input.tier ?? modelTier(input.model);
  if (!tier) return unchanged;
  const current = input.model ? remaining({ provider: family, model: input.model }, input.quota, input.nowSec) : null;
  if (!input.tier && current !== 0) return unchanged;
  const candidates = input.candidates.filter(c => modelTier(c.model) === (tier === "low" ? "medium" : tier))
    .map(c => ({ ...c, remaining: remaining(c, input.quota, input.nowSec) }))
    .filter((c): c is ModelCandidate & { remaining: number } => c.remaining !== null && c.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining
      || Number(b.provider === family) - Number(a.provider === family)
      || a.model.localeCompare(b.model));
  const chosen = candidates[0];
  if (!chosen) return { ok: false, error: `model_quota_unavailable:${tier}` };
  return { ok: true, provider: chosen.provider === family ? input.provider : chosen.provider,
    model: chosen.model, ...(input.tier ? { effort: tier === "low" ? "low" : "high" } : {}),
    reason: input.tier ? `tier:${tier}` : `quota-exhausted:${input.provider}:${input.model}` };
}
