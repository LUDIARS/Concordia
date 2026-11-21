export interface BreakerConfig {
  consecutive_failures: number;
  target_oscillation: number;
  concurrency_limit: number;
  trigger_rate_limit: number;
  cooldown_ms: number | null;
}

export type AutomaticBreakerReason = "daily_cost_limit" | "consecutive_failures" | "target_oscillation"
  | "concurrency_limit" | "trigger_rate_limit";
export type BreakerReason = AutomaticBreakerReason | "manual";

export interface BreakerSignals {
  costBlocked: boolean;
  failures: number;
  start: { targetAttempts: number; active: number; totalAttempts: number } | null;
}

export interface BreakerTarget {
  project_code: string;
  target_key: string;
  session_id: string | null;
}
