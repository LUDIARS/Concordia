export interface HaltedLoop {
  name: string;
  consecutive_failures: number;
  halted_at: number;
  last_error: string;
}

export interface LoopBulkheadOptions {
  maxConsecutiveFailures?: number;
  now?: () => number;
  onHalt?: (state: HaltedLoop) => void;
  log?: { warn: (message: string) => void };
}

export interface LoopBulkhead {
  run: (tick: () => Promise<unknown> | unknown) => Promise<boolean>;
  isHalted: () => boolean;
}

export interface SupervisedIntervalOptions extends LoopBulkheadOptions {
  intervalMs: number;
  initialDelayMs?: number;
}

export interface SupervisedIntervalHandle {
  stop: () => void;
  isHalted: () => boolean;
}

const haltedLoops = new Map<string, HaltedLoop>();
let haltNotifier: ((state: HaltedLoop) => Promise<void> | void) | null = null;

export function configureLoopHaltNotifier(
  notifier: ((state: HaltedLoop) => Promise<void> | void) | null,
): void {
  haltNotifier = notifier;
}

export function listHaltedLoops(): HaltedLoop[] {
  return [...haltedLoops.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function createLoopBulkhead(name: string, options: LoopBulkheadOptions = {}): LoopBulkhead {
  const maxFailures = positiveInteger(
    options.maxConsecutiveFailures ?? process.env.CONCORDIA_LOOP_MAX_CONSECUTIVE_FAILURES,
    5,
  );
  const now = options.now ?? Date.now;
  let consecutiveFailures = 0;
  let halted = false;

  return {
    isHalted: () => halted,
    run: async (tick) => {
      if (halted) return false;
      try {
        await tick();
        consecutiveFailures = 0;
        return true;
      } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        options.log?.warn(
          `loop ${name} failed (${consecutiveFailures}/${maxFailures}): ${message}`,
        );
        if (consecutiveFailures < maxFailures) return false;

        halted = true;
        const state: HaltedLoop = {
          name,
          consecutive_failures: consecutiveFailures,
          halted_at: now(),
          last_error: message,
        };
        haltedLoops.set(name, state);
        try { options.onHalt?.(state); } catch { /* isolation boundary */ }
        void Promise.resolve(haltNotifier?.(state)).catch(() => { /* notification must not spread */ });
        return false;
      }
    },
  };
}

export function startSupervisedInterval(
  name: string,
  tick: () => Promise<unknown> | unknown,
  options: SupervisedIntervalOptions,
): SupervisedIntervalHandle {
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let initial: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    stopped = true;
    if (interval) clearInterval(interval);
    if (initial) clearTimeout(initial);
    interval = null;
    initial = null;
  };
  const bulkhead = createLoopBulkhead(name, {
    ...options,
    onHalt: (state) => {
      stop();
      options.onHalt?.(state);
    },
  });
  const run = (): void => {
    if (stopped) return;
    void bulkhead.run(tick);
  };
  if (options.initialDelayMs !== undefined) {
    initial = setTimeout(run, Math.max(0, options.initialDelayMs));
    initial.unref?.();
  }
  interval = setInterval(run, Math.max(1, options.intervalMs));
  interval.unref?.();
  return { stop, isHalted: bulkhead.isHalted };
}

export function resetLoopBulkheadsForTest(): void {
  haltedLoops.clear();
  haltNotifier = null;
}

function positiveInteger(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
