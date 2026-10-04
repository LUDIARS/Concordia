/**
 * 周期実行の小さな枠。 消費の計上と通知の配達が使う。
 *
 * 前の周期が終わっていなければ次を重ねない。 停止は重ねて呼んでも安全で、 停止後は新しい周期を
 * 始めない。 寿命は生成した composition root が所有する。
 *
 * @implements spec/feature/personal-ai-budget.md §10
 * @implements SPEC-PBUDGET-CONSUME
 * @implements SPEC-PBUDGET-REWARD
 */

export interface PeriodicHandle {
  stop(): void;
}

export function startPeriodic(input: {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  log?: { warn: (message: string) => void };
}): PeriodicHandle {
  let running = false;
  let stopped = false;
  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    void input.run()
      .catch((error: unknown) => {
        input.log?.warn(`${input.name} tick failed: ${(error as Error).message}`);
      })
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, input.intervalMs);
  timer.unref?.();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}
