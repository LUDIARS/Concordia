/**
 * event loop の停止 (stall) を検知して記録する。
 *
 * WHY: Discord interaction は作成から 3 秒以内に ack しないと token が失効し
 * `10062 Unknown interaction` になる。 2026-07-26 の調査で、失敗時は **dispatch 自体が
 * 258〜474ms と速い**のに ack が 5.6〜9.8 秒かかっており、 直前に **14 秒間ログが完全に
 * 途切れて復帰時へ一斉処理**されていた = event loop が同期処理で塞がれていた。
 *
 * この現象は少なくとも 2026-07-15 から続いており (07-15: 遅延 12 件 / 最悪 65 秒、
 * 07-16: 7 件 / 48 秒、07-25: 10 件 / 11 秒、07-26: 2 件 / 9.8 秒)、 PR #348-#358 で
 * 大幅に改善したものの根治していない。 これまでは「ログの空白」から事後推測するしか
 * 手段が無く、 発生頻度が低いため CPU プロファイルでも捕まえられなかった
 * (90 秒サンプリングで 97.8% idle)。
 *
 * WHAT: 短周期タイマーの **実発火遅延** で stall を検知する。 `monitorEventLoopDelay` の
 * ヒストグラムは分布しか分からず「いつ止まったか」を特定できないため、 こちらを主指標にし、
 * ヒストグラムは補助統計として併記する。 stall 時は active handle / request 数も添える
 * (ハンドルリークやペンディング I/O 過多の切り分け材料)。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

export interface EventLoopStall {
  /** 期待発火時刻からの超過 (ms)。 実質「event loop が塞がっていた時間」。 */
  lagMs: number;
  /** 検知時刻 (epoch ms)。 */
  at: number;
  /** その時点の active handle 数 (-1 = 取得不可)。 */
  activeHandles: number;
  /** その時点の active request 数 (-1 = 取得不可)。 */
  activeRequests: number;
}

export interface EventLoopSummary {
  /** 集計区間で観測した最大 lag (ms)。 タイマー遅延ベース。 */
  maxLagMs: number;
  /** 区間中の stall 件数。 */
  stalls: number;
  /** perf_hooks ヒストグラム由来 (ns → ms 換算)。 */
  histogramMaxMs: number;
  histogramMeanMs: number;
  histogramP99Ms: number;
}

export interface EventLoopMonitorOptions {
  /** 監視タイマー間隔 (ms)。 既定 100。 */
  tickMs?: number;
  /** この超過を上回ったら stall として記録 (ms)。 既定 1000。 */
  stallThresholdMs?: number;
  /** 統計を出す間隔 (ms)。 既定 60_000。 0 以下で無効。 */
  summaryIntervalMs?: number;
  onStall: (stall: EventLoopStall) => void;
  onSummary?: (summary: EventLoopSummary) => void;
  /** テスト用フック。 */
  now?: () => number;
  histogram?: IntervalHistogram | null;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface EventLoopMonitorHandle {
  stop: () => void;
}

/** `process._getActiveHandles` 等の内部 API を安全に数える (無ければ -1)。 */
function countActive(name: "_getActiveHandles" | "_getActiveRequests"): number {
  try {
    const fn = (process as unknown as Record<string, unknown>)[name];
    if (typeof fn !== "function") return -1;
    const list = (fn as () => unknown).call(process);
    return Array.isArray(list) ? list.length : -1;
  } catch {
    return -1;
  }
}

export function startEventLoopMonitor(opts: EventLoopMonitorOptions): EventLoopMonitorHandle {
  const tickMs = opts.tickMs ?? 100;
  const stallThresholdMs = opts.stallThresholdMs ?? 1_000;
  const summaryIntervalMs = opts.summaryIntervalMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  // histogram に null を明示すると無効化できる (テスト・低オーバーヘッド運用)。
  const histogram = opts.histogram === null
    ? null
    : opts.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  histogram?.enable();

  let lastTickAt = now();
  let maxLagMs = 0;
  let stalls = 0;
  let sinceSummaryMs = 0;

  const tick = (): void => {
    const at = now();
    // 期待どおりなら経過は tickMs。 それを超えた分が event loop の詰まり。
    const lagMs = at - lastTickAt - tickMs;
    lastTickAt = at;
    if (lagMs > maxLagMs) maxLagMs = lagMs;

    if (lagMs >= stallThresholdMs) {
      stalls++;
      opts.onStall({
        lagMs,
        at,
        activeHandles: countActive("_getActiveHandles"),
        activeRequests: countActive("_getActiveRequests"),
      });
    }

    if (summaryIntervalMs > 0 && opts.onSummary) {
      // stall 中は tick 自体が飛ぶので、 実経過で加算する (tickMs 固定だとズレる)。
      sinceSummaryMs += Math.max(tickMs, lagMs + tickMs);
      if (sinceSummaryMs >= summaryIntervalMs) {
        opts.onSummary({
          maxLagMs,
          stalls,
          histogramMaxMs: histogram ? histogram.max / 1e6 : -1,
          histogramMeanMs: histogram ? histogram.mean / 1e6 : -1,
          histogramP99Ms: histogram ? histogram.percentile(99) / 1e6 : -1,
        });
        maxLagMs = 0;
        stalls = 0;
        sinceSummaryMs = 0;
        histogram?.reset();
      }
    }
  };

  const handle = setIntervalFn(tick, tickMs);
  (handle as { unref?: () => void })?.unref?.();

  return {
    stop: () => {
      clearIntervalFn(handle);
      histogram?.disable();
    },
  };
}
