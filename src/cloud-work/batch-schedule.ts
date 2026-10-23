const DEFAULT_INTERVAL_SEC = 180, MIN_INTERVAL_SEC = 60;

/** Interval in ms; undefined when the cloud configuration is absent (no background kicks). */
export function cloudBatchKickInterval(env: NodeJS.ProcessEnv): number | undefined {
  if (!env.CONCORDIA_CLOUD_CONFIG_FILE) return undefined;
  const raw = Number(env.CONCORDIA_CLOUD_KICK_INTERVAL_SEC ?? DEFAULT_INTERVAL_SEC);
  const seconds = Number.isFinite(raw) ? Math.max(MIN_INTERVAL_SEC, Math.floor(raw)) : DEFAULT_INTERVAL_SEC;
  return seconds * 1000;
}

/** Starts the periodic sweep. Stopping the timer never claims to stop remote work. */
export function startCloudBatchSchedule(kicker: { tickAll(): Promise<void> }, env: NodeJS.ProcessEnv,
  timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = globalThis): () => Promise<void> {
  const interval = cloudBatchKickInterval(env);
  if (interval === undefined) return async () => undefined;
  let current: Promise<void> | null = null;
  const handle = timers.setInterval(() => {
    // Periodic work is best-effort; per-batch state exposes safe failures and the
    // next interval must remain available after a transient sweep failure.
    current ??= kicker.tickAll().catch(() => undefined).finally(() => { current = null; });
  }, interval);
  (handle as { unref?: () => void }).unref?.();
  return async () => { timers.clearInterval(handle); await current; };
}
