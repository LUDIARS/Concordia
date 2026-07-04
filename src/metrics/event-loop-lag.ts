/**
 * Event-loop lag サンプラー。
 *
 * Node 標準の `perf_hooks.monitorEventLoopDelay()` を薄く包み、
 * 定期的に { mean, p50, p99, max } スナップショットを提供する。
 * Phase 3 の process 分離効果の物差しとして使い、
 * cost 起因ブロック (#255/#257) の再発検知も兼ねる。
 */

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("metrics:lag");

/** p99 がこの値を超えると warn を出す (ms)。 */
export const P99_WARN_THRESHOLD_MS = 200;

export interface LagSnapshot {
  mean: number;
  p50: number;
  p99: number;
  max: number;
}

/** monitorEventLoopDelay の依存を差し替えられるようにするファクトリ型 (テスト用)。 */
export type HistogramFactory = (opts: { resolution: number }) => IntervalHistogram;

export class EventLoopLagSampler {
  private histogram: IntervalHistogram | null = null;
  private readonly factory: HistogramFactory;

  constructor(factory: HistogramFactory = monitorEventLoopDelay) {
    this.factory = factory;
  }

  enable(): void {
    if (this.histogram) return;
    this.histogram = this.factory({ resolution: 10 });
    this.histogram.enable();
  }

  disable(): void {
    if (!this.histogram) return;
    this.histogram.disable();
    this.histogram = null;
  }

  /**
   * 現在の計測値をスナップショットとして返す。
   * 呼び出し後、ヒストグラムを reset() してカウントをクリアする。
   * サンプラーが未有効化の場合はすべて 0 を返す。
   */
  snapshot(): LagSnapshot {
    const h = this.histogram;
    if (!h) return { mean: 0, p50: 0, p99: 0, max: 0 };

    const nsToMs = (ns: number): number =>
      Math.round((ns / 1e6) * 100) / 100;

    const snap: LagSnapshot = {
      mean: nsToMs(h.mean),
      p50: nsToMs(h.percentile(50)),
      p99: nsToMs(h.percentile(99)),
      max: nsToMs(h.max),
    };

    if (snap.p99 > P99_WARN_THRESHOLD_MS) {
      log.warn(
        { p99Ms: snap.p99, thresholdMs: P99_WARN_THRESHOLD_MS },
        "event-loop lag p99 exceeded threshold",
      );
    }

    h.reset();
    return snap;
  }
}
