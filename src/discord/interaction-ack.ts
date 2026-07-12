export interface AckObservableInteraction {
  createdTimestamp?: number;
  deferred?: boolean;
  replied?: boolean;
  responded?: boolean;
}

export interface InteractionAckResult {
  acknowledged: boolean;
  within_3s: boolean;
  duration_ms: number;
}

export function startInteractionAckProbe(
  interaction: AckObservableInteraction,
  record: (result: InteractionAckResult) => void,
  opts: { now?: () => number; pollMs?: number; deadlineMs?: number } = {},
): { stop: () => void } {
  const now = opts.now ?? Date.now;
  const startedAt = interaction.createdTimestamp ?? now();
  const deadlineMs = opts.deadlineMs ?? 3_000;
  let finished = false;
  const finish = (acknowledged: boolean): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    const duration = Math.max(0, now() - startedAt);
    record({ acknowledged, within_3s: acknowledged && duration <= deadlineMs, duration_ms: duration });
  };
  const acknowledged = (): boolean =>
    interaction.deferred === true || interaction.replied === true || interaction.responded === true;
  const inspect = (): void => {
    if (acknowledged()) finish(true);
    else if (now() - startedAt >= deadlineMs) finish(false);
  };
  const timer = setInterval(inspect, opts.pollMs ?? 25);
  timer.unref?.();
  inspect();
  return { stop: () => finish(acknowledged()) };
}
