import { describe, expect, it } from "vitest";
import {
  startEventLoopMonitor,
  type EventLoopStall,
  type EventLoopSummary,
} from "./event-loop-monitor.js";

/** 時計とタイマーを手動駆動して、実時間に依存せず決定的に検証する。 */
function harness(tickMs: number) {
  let clock = 1_000_000;
  let fire: (() => void) | null = null;
  let cleared = false;
  return {
    now: () => clock,
    setIntervalFn: (fn: () => void) => {
      fire = fn;
      return { unref: () => undefined };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    get cleared() {
      return cleared;
    },
    /** 実時間で elapsedMs 経過したことにして tick を 1 回起こす。 */
    advanceAndTick(elapsedMs: number) {
      clock += elapsedMs;
      fire?.();
    },
    /** 遅延なし (期待どおり tickMs で発火) の tick。 */
    normalTick() {
      this.advanceAndTick(tickMs);
    },
  };
}

describe("startEventLoopMonitor", () => {
  it("期待どおりに発火している間は stall を出さない", () => {
    const h = harness(100);
    const stalls: EventLoopStall[] = [];
    startEventLoopMonitor({
      tickMs: 100,
      stallThresholdMs: 1_000,
      summaryIntervalMs: 0,
      onStall: (s) => stalls.push(s),
      now: h.now,
      histogram: null,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    for (let i = 0; i < 20; i++) h.normalTick();
    expect(stalls).toHaveLength(0);
  });

  it("閾値を超えた発火遅延を stall として記録し、塞がっていた時間を返す", () => {
    const h = harness(100);
    const stalls: EventLoopStall[] = [];
    startEventLoopMonitor({
      tickMs: 100,
      stallThresholdMs: 1_000,
      summaryIntervalMs: 0,
      onStall: (s) => stalls.push(s),
      now: h.now,
      histogram: null,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    h.normalTick();
    // 100ms 間隔のはずが 14.4 秒後に発火 = 14.3 秒 event loop が塞がっていた
    // (2026-07-26 に実測した stall と同じ形)。
    h.advanceAndTick(14_400);
    h.normalTick();

    expect(stalls).toHaveLength(1);
    expect(stalls[0].lagMs).toBe(14_300);
    expect(stalls[0].at).toBeGreaterThan(0);
  });

  it("閾値ちょうどは stall 扱い、 わずかに下回れば無視する", () => {
    const h = harness(100);
    const stalls: EventLoopStall[] = [];
    startEventLoopMonitor({
      tickMs: 100,
      stallThresholdMs: 1_000,
      summaryIntervalMs: 0,
      onStall: (s) => stalls.push(s),
      now: h.now,
      histogram: null,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    h.advanceAndTick(1_099); // lag 999ms → 無視
    h.advanceAndTick(1_100); // lag 1000ms → 記録
    expect(stalls.map((s) => s.lagMs)).toEqual([1_000]);
  });

  it("stall の件数と最大 lag を summary で集計し、集計後にリセットする", () => {
    const h = harness(100);
    const summaries: EventLoopSummary[] = [];
    startEventLoopMonitor({
      tickMs: 100,
      stallThresholdMs: 1_000,
      summaryIntervalMs: 5_000,
      onStall: () => undefined,
      onSummary: (s) => summaries.push(s),
      now: h.now,
      histogram: null,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });

    h.advanceAndTick(3_100); // lag 3000ms (stall)
    h.advanceAndTick(2_100); // lag 2000ms (stall) → ここで 5s 到達し summary
    expect(summaries).toHaveLength(1);
    expect(summaries[0].stalls).toBe(2);
    expect(summaries[0].maxLagMs).toBe(3_000);

    // リセット後は次の区間として数え直す。
    h.advanceAndTick(5_200); // lag 5100ms (stall) → 再び summary
    expect(summaries).toHaveLength(2);
    expect(summaries[1].stalls).toBe(1);
    expect(summaries[1].maxLagMs).toBe(5_100);
  });

  it("stop でタイマーを解除する", () => {
    const h = harness(100);
    const handle = startEventLoopMonitor({
      tickMs: 100,
      summaryIntervalMs: 0,
      onStall: () => undefined,
      now: h.now,
      histogram: null,
      setIntervalFn: h.setIntervalFn,
      clearIntervalFn: h.clearIntervalFn,
    });
    expect(h.cleared).toBe(false);
    handle.stop();
    expect(h.cleared).toBe(true);
  });
});
