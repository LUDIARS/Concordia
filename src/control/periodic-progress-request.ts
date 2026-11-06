import { readGoalAndGoStatus } from "./goal-and-go.js";
import { isAutoConfirmStruckOut } from "./auto-confirm-strikes.js";
import { isSuspended, readSuspension } from "../cost/budget-suspension.js";
import { shouldRequestProgress } from "./periodic-progress-policy.js";

export interface ProgressLimits { maxContinuations: number; maxRuntimeSec: number }

/** Read state owned by existing controllers; never reset their budgets or waits. */
export function canRequestProgress(metadata: string | null, nowMs: number, intervalMs: number,
  limits: ProgressLimits): boolean {
  const status = readGoalAndGoStatus(metadata);
  let lastContactMs: number | null = null;
  try {
    const last = (JSON.parse(metadata ?? "{}") as { cc_nudge_delivery?: { sentAt?: unknown } }).cc_nudge_delivery?.sentAt;
    if (typeof last === "number") lastContactMs = last;
  } catch { /* Invalid metadata has no recorded contact; the owners still apply their defaults. */ }
  return !isAutoConfirmStruckOut(metadata) && shouldRequestProgress({
    hasScope: true, enabled: status.enabled, stopped: status.stopped_reason !== null,
    budgetSuspended: isSuspended(readSuspension(metadata)), continuationCount: status.continuation_count,
    maxContinuations: limits.maxContinuations, startedAtSec: status.started_at,
    maxRuntimeSec: limits.maxRuntimeSec, lastContactMs, nowMs, intervalMs,
  });
}
