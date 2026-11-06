import type { ProgressRequestInput } from "./periodic-progress-policy.js";

/** Independent safety invariant: every request has a live scope, budget and a fresh contact slot. */
export default {
  post(result: unknown, input: ProgressRequestInput): boolean {
    if (result !== true) return result === false;
    return input.hasScope && input.enabled && !input.stopped && !input.budgetSuspended
      && input.continuationCount < input.maxContinuations
      && (input.startedAtSec === null || input.nowMs / 1000 - input.startedAtSec < input.maxRuntimeSec)
      && (input.lastContactMs === null || input.nowMs - input.lastContactMs >= input.intervalMs);
  },
};
