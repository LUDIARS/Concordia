import type { GrokUsage } from "./grok-usage.js";

export default {
  post(result: GrokUsage | null, line: string, nowSec: number): boolean {
    try {
      const entry = JSON.parse(line);
      const period = entry?.ctx?.config?.currentPeriod;
      const used = entry?.ctx?.config?.creditUsagePercent;
      const end = period?.end ?? entry?.ctx?.config?.billingPeriodEnd;
      const reset = typeof end === "string" ? Math.floor(Date.parse(end) / 1000) : NaN;
      const observed = typeof entry?.ts === "string" ? Math.floor(Date.parse(entry.ts) / 1000) : NaN;
      const plan = entry?.ctx?.subscriptionTier;
      const valid = entry?.msg === "billing: fetched credits config"
        && (period?.type == null || period.type === "USAGE_PERIOD_TYPE_WEEKLY")
        && typeof used === "number" && used >= 0 && used <= 100
        && reset > nowSec && Number.isFinite(observed);
      if (!valid) return result === null;
      return result?.usedWeeklyPct === used
        && result.resetWeeklyAt === reset
        && result.observedAtSec === observed
        && result.plan === (typeof plan === "string" ? plan : null);
    } catch {
      return result === null;
    }
  },
};
