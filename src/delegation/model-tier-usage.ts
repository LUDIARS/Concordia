/** Usage I/O for shared Delegation launch; policy remains transport independent. */
import { fetchClaudeOAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits, codexRateObservationTime } from "../cost/codex-rate-limits.js";
import { createChildLogger } from "../shared/logger.js";
import type { ModelQuota, QuotaObservation } from "./model-tier-policy.js";
const log = createChildLogger("delegation-model-usage");
const observation = (used?: number | null, reset?: number | null): QuotaObservation =>
  ({ used: used ?? null, reset: reset ?? null });
export async function collectDelegationModelQuota(): Promise<ModelQuota> {
  return (await collectModelQuotaSnapshot()).quota;
}
/** @implements spec/feature/shared-available-one-shot.md CC-OS-02 */
export async function collectModelQuotaSnapshot(): Promise<{
  quota: ModelQuota; observedAt: { claude: number | null; codex: number | null };
}> {
  const [claude, codex] = await Promise.all([
    fetchClaudeOAuthUsage({ log }), fetchCodexRateLimits({ log }),
  ]);
  return { observedAt: { claude: claude?.fetchedAt ?? null, codex: codexRateObservationTime(codex) }, quota: {
    claude: [observation(claude?.fiveHour?.utilization, claude?.fiveHour?.resetsAtSec),
      observation(claude?.sevenDay?.utilization, claude?.sevenDay?.resetsAtSec)],
    codex: [
      ...(codex?.absentWindows?.includes("fiveHour") ? [] : [observation(codex?.used5h, codex?.reset5hAt)]),
      ...(codex?.absentWindows?.includes("weekly") ? [] : [observation(codex?.usedWeekly, codex?.resetWeeklyAt)]),
    ],
    opus: claude?.sevenDayOpus ? observation(claude.sevenDayOpus.utilization, claude.sevenDayOpus.resetsAtSec) : null,
    sonnet: claude?.sevenDaySonnet ? observation(claude.sevenDaySonnet.utilization, claude.sevenDaySonnet.resetsAtSec) : null,
  } };
}
