import type { LagSnapshot } from "./event-loop-lag.js";

export interface EventLoopLagAlertOptions {
  thresholdMs: number;
  consecutiveSamples: number;
  cooldownMs: number;
  now?: () => number;
  notify: (snapshot: LagSnapshot) => Promise<void> | void;
}

export class EventLoopLagAlert {
  private consecutive = 0;
  private lastNotifiedAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;

  constructor(private readonly options: EventLoopLagAlertOptions) {
    this.now = options.now ?? Date.now;
  }

  observe(snapshot: LagSnapshot): void {
    if (snapshot.p99 <= this.options.thresholdMs) {
      this.consecutive = 0;
      return;
    }
    this.consecutive += 1;
    if (this.consecutive < this.options.consecutiveSamples) return;
    const now = this.now();
    if (now - this.lastNotifiedAt < this.options.cooldownMs) return;
    this.lastNotifiedAt = now;
    void Promise.resolve(this.options.notify(snapshot)).catch(() => { /* alert delivery is isolated */ });
  }
}
