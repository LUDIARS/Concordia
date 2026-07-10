export interface DiscordRestartPolicyState {
  stops: number[];
}

export interface DiscordRestartDecision {
  shouldRestart: boolean;
  limited: boolean;
  recentStops: number;
}

export function recordDiscordBotStop(
  state: DiscordRestartPolicyState,
  input: { nowMs: number; windowMs: number; limit: number },
): DiscordRestartDecision {
  const windowMs = Math.max(1, Math.floor(input.windowMs));
  const limit = Math.max(1, Math.floor(input.limit));
  const cutoff = input.nowMs - windowMs;
  state.stops = state.stops.filter((ts) => ts >= cutoff);
  state.stops.push(input.nowMs);
  const limited = state.stops.length >= limit;
  return {
    shouldRestart: !limited,
    limited,
    recentStops: state.stops.length,
  };
}
