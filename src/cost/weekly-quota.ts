import type { CostLimitSampleInput } from "../db/cost-limit-samples-repo.js";
import type { GrokUsage } from "./grok-usage.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4fbec0ac */
import augurContract_c84cc234 from './weekly-quota.contract.js'; /* augur-inject:contract-predicate:9d0b82d6 */

const PROVIDERS = [
  { key: "chatgpt", provider: "codex-cli", label: "ChatGPT" },
  { key: "claude", provider: "claude-code", label: "Claude" },
  { key: "gemini", provider: "antigravity-cli", label: "Gemini" },
  { key: "grok", provider: "grok-cli", label: "Grok" },
] as const;

export type WeeklyQuota = (typeof PROVIDERS)[number] & {
  plan: string | null;
  usedWeeklyPct: number | null;
  remainWeeklyPct: number | null;
  resetWeeklyAt: number | null;
  sampledAt: number | null;
};

/** @implements CC-COST-QUOTA-INV-01 */
export function latestWeeklyQuotas(
  samples: readonly CostLimitSampleInput[],
  grok: GrokUsage | null,
  nowSec: number,
): WeeklyQuota[] {
  return PROVIDERS.map((provider) => {
    const saved = samples.find((sample) => sample.provider === provider.provider);
    const live = provider.key === "grok" && grok && (!saved || grok.observedAtSec > saved.ts) ? grok : null;
    const resetWeeklyAt = live ? live.resetWeeklyAt : saved?.reset_weekly_at ?? null;
    const used = live ? live.usedWeeklyPct : saved?.used_weekly_pct ?? null;
    const usedWeeklyPct = resetWeeklyAt !== null && resetWeeklyAt <= nowSec ? null : used;
    const remainWeeklyPct = usedWeeklyPct === null
      ? null
      : Math.max(0, Math.min(100, Math.round((100 - usedWeeklyPct) * 10) / 10));
    return {
      ...provider,
      plan: live ? live.plan : saved?.plan ?? null,
      usedWeeklyPct,
      remainWeeklyPct,
      resetWeeklyAt,
      sampledAt: live?.observedAtSec ?? saved?.ts ?? null,
    };
  });
}
// @ts-expect-error augur-inject
latestWeeklyQuotas = contract(latestWeeklyQuotas, { ...augurContract_c84cc234, contractId: 'weekly-ai-quota-C-2', mode: 'observe', sample: 1, where: 'src/cost/weekly-quota.ts:20', rule: 'contract-wrap', id: 'c84cc234' }); /* augur-inject:contract-wrap:c84cc234 */
