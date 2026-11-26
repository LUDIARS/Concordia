import type { CostLimitSampleInput } from "../db/cost-limit-samples-repo.js";
import type { GrokUsage } from "./grok-usage.js";
import type { WeeklyQuota } from "./weekly-quota.js";

const identities = [
  ["chatgpt", "codex-cli", "ChatGPT"],
  ["claude", "claude-code", "Claude"],
  ["gemini", "antigravity-cli", "Gemini"],
  ["grok", "grok-cli", "Grok"],
] as const;

export default {
  post(result: WeeklyQuota[], samples: readonly CostLimitSampleInput[], grok: GrokUsage | null, nowSec: number): boolean {
    return result.length === identities.length && identities.every(([key, provider, label], index) => {
      const row = result[index];
      const saved = samples.find((sample) => sample.provider === provider);
      const live = key === "grok" && grok && (!saved || grok.observedAtSec > saved.ts) ? grok : null;
      const reset = live ? live.resetWeeklyAt : saved?.reset_weekly_at ?? null;
      const used = reset !== null && reset <= nowSec ? null : live ? live.usedWeeklyPct : saved?.used_weekly_pct ?? null;
      const remaining = used === null ? null : Math.min(100, Math.max(0, Math.round((100 - used) * 10) / 10));
      return row.key === key && row.provider === provider && row.label === label
        && row.plan === (live ? live.plan : saved?.plan ?? null)
        && row.sampledAt === (live?.observedAtSec ?? saved?.ts ?? null)
        && row.resetWeeklyAt === reset && row.usedWeeklyPct === used && row.remainWeeklyPct === remaining;
    });
  },
};
