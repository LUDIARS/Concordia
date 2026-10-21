/** Usage I/O for shared Delegation launch; policy remains transport independent. */
import { fetchClaudeOAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits } from "../cost/codex-rate-limits.js";
import { createChildLogger } from "../shared/logger.js";
import type { ModelQuota, QuotaObservation } from "./model-tier-policy.js";
const log = createChildLogger("delegation-model-usage");
const observation = (used?: number | null, reset?: number | null): QuotaObservation =>
  ({ used: used ?? null, reset: reset ?? null });
export async function collectDelegationModelQuota(): Promise<ModelQuota> {
  const [claude, codex] = await Promise.all([
    fetchClaudeOAuthUsage({ log }), fetchCodexRateLimits({ log }),
  ]);
  return {
    claude: [observation(claude?.fiveHour?.utilization, claude?.fiveHour?.resetsAtSec),
      observation(claude?.sevenDay?.utilization, claude?.sevenDay?.resetsAtSec)],
    codex: [
      ...(codex?.absentWindows?.includes("fiveHour") ? [] : [observation(codex?.used5h, codex?.reset5hAt)]),
      ...(codex?.absentWindows?.includes("weekly") ? [] : [observation(codex?.usedWeekly, codex?.resetWeeklyAt)]),
    ],
    opus: claude?.sevenDayOpus ? observation(claude.sevenDayOpus.utilization, claude.sevenDayOpus.resetsAtSec) : null,
    sonnet: claude?.sevenDaySonnet ? observation(claude.sevenDaySonnet.utilization, claude.sevenDaySonnet.resetsAtSec) : null,
  };
}
