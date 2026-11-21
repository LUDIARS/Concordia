import { contract } from './ontime-runtime.js'; /* augur-inject:import:155b3ac9 */
import augurContract_38d88bc8 from './breaker-reason.contract.js'; /* augur-inject:contract-predicate:d4426375 */
import augurContract_fa886f8b from './breaker-cooldown.contract.js'; /* augur-inject:contract-predicate:8b7fde07 */
import type { AutomaticBreakerReason, BreakerConfig, BreakerReason, BreakerSignals, BreakerTarget } from "./circuit-breaker-types.js";

export type * from "./circuit-breaker-types.js";
/** @implements spec/feature/cdgd-management.md CC-MGMT-09 / CC-MGMT-INV-10 */
export const TARGET_WINDOW_MS = 30 * 60_000;
export const TRIGGER_WINDOW_MS = 5 * 60_000;

export function breakerReason(config: BreakerConfig, signals: BreakerSignals): AutomaticBreakerReason | null {
  if (signals.costBlocked) return "daily_cost_limit";
  if (signals.failures >= config.consecutive_failures) return "consecutive_failures";
  if (!signals.start) return null;
  if (signals.start.targetAttempts >= config.target_oscillation) return "target_oscillation";
  if (signals.start.active >= config.concurrency_limit) return "concurrency_limit";
  if (signals.start.totalAttempts >= config.trigger_rate_limit) return "trigger_rate_limit";
  return null;
}
// @ts-expect-error augur-inject
breakerReason = contract(breakerReason, { ...augurContract_38d88bc8, contractId: 'C-43', mode: 'observe', sample: 1, where: 'src/management/circuit-breaker.ts:11', rule: 'contract-wrap', id: '38d88bc8' }); /* augur-inject:contract-wrap:38d88bc8 */

export function canCooldown(openedAt: number | null, cooldownMs: number | null, now: number): boolean {
  return openedAt !== null && cooldownMs !== null && now - openedAt >= cooldownMs;
}
// @ts-expect-error augur-inject
canCooldown = contract(canCooldown, { ...augurContract_fa886f8b, contractId: 'C-44', mode: 'observe', sample: 1, where: 'src/management/circuit-breaker.ts:23', rule: 'contract-wrap', id: 'fa886f8b' }); /* augur-inject:contract-wrap:fa886f8b */

export function formatBreakerAlert(reason: BreakerReason, target: BreakerTarget | null, link: string | null): string {
  const lines = [`自走ループを遮断しました (${reason})`];
  if (target) {
    const safeTarget = `${target.project_code} / ${target.target_key}`.replace(/[^A-Za-z0-9._:/ -]/g, "_");
    lines.push(`対象 \`${safeTarget}\``);
  }
  if (link && /^https:\/\/discord\.com\/channels\/\d+\/\d+(?:\/\d+)?$/.test(link)) lines.push(`セッション ${link}`);
  else if (target?.session_id) lines.push(`セッション ${target.session_id.replace(/[^A-Za-z0-9._-]/g, "_")}`);
  return lines.join("\n");
}
