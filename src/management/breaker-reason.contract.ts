import type { BreakerConfig, BreakerSignals, AutomaticBreakerReason } from "./circuit-breaker-types.js";

export default {
  post(result: AutomaticBreakerReason | null, config: BreakerConfig, signals: BreakerSignals): boolean {
    const eligible: readonly [AutomaticBreakerReason, boolean][] = [
      ["daily_cost_limit", signals.costBlocked],
      ["consecutive_failures", signals.failures >= config.consecutive_failures],
      ["target_oscillation", signals.start !== null && signals.start.targetAttempts >= config.target_oscillation],
      ["concurrency_limit", signals.start !== null && signals.start.active >= config.concurrency_limit],
      ["trigger_rate_limit", signals.start !== null && signals.start.totalAttempts >= config.trigger_rate_limit],
    ];
    return result === (eligible.find(([, matched]) => matched)?.[0] ?? null);
  },
};
