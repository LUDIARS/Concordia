import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventLoopLagSampler, P99_WARN_THRESHOLD_MS } from "./event-loop-lag.js";
import type { IntervalHistogram } from "node:perf_hooks";

// pino child logger の warn をスパイするため、 shared/logger をモックする。
vi.mock("../shared/logger.js", () => {
  const warn = vi.fn();
  const info = vi.fn();
  return {
    createChildLogger: () => ({ warn, info }),
    rootLogger: { child: () => ({ warn, info }) },
  };
});

/** テスト用の偽ヒストグラムを作るファクトリ。 値は ms 単位で受け取り、 ns に変換して返す。 */
function makeFakeHistogram(values: {
  mean: number;
  p50: number;
  p99: number;
  max: number;
}): IntervalHistogram & { reset: ReturnType<typeof vi.fn> } {
  const reset = vi.fn();
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    reset,
    get mean() { return values.mean * 1e6; },
    get max() { return values.max * 1e6; },
    percentile(pct: number) {
      if (pct === 50) return values.p50 * 1e6;
      if (pct === 99) return values.p99 * 1e6;
      return 0;
    },
    get min() { return 0; },
    get stddev() { return 0; },
    get count() { return 1; },
    exceeds: 0,
    resolution: 10,
    percentilesBigInt: vi.fn(),
    percentiles: vi.fn(() => new Map()),
    toJSON: vi.fn(() => ({})),
    [Symbol.iterator]: vi.fn(),
  } as unknown as IntervalHistogram & { reset: ReturnType<typeof vi.fn> };
}

function makeFactory(values: { mean: number; p50: number; p99: number; max: number }) {
  const hist = makeFakeHistogram(values);
  return {
    hist,
    factory: (_opts: { resolution: number }) => hist as IntervalHistogram,
  };
}

/** モックされた logger の warn 関数を取得する。 */
async function getWarnSpy() {
  const logger = await import("../shared/logger.js");
  // @ts-expect-error — モックなので warn は存在する
  return logger.createChildLogger("") as { warn: ReturnType<typeof vi.fn> };
}

describe("EventLoopLagSampler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("snapshot() が { mean, p50, p99, max } の形状を返す", () => {
    const { factory } = makeFactory({ mean: 5, p50: 4, p99: 10, max: 15 });
    const sampler = new EventLoopLagSampler(factory);
    sampler.enable();

    const snap = sampler.snapshot();

    expect(snap).toMatchObject({
      mean: expect.any(Number),
      p50: expect.any(Number),
      p99: expect.any(Number),
      max: expect.any(Number),
    });
    expect(snap.mean).toBeCloseTo(5, 1);
    expect(snap.p50).toBeCloseTo(4, 1);
    expect(snap.p99).toBeCloseTo(10, 1);
    expect(snap.max).toBeCloseTo(15, 1);

    sampler.disable();
  });

  it("snapshot() の後に histogram.reset() が呼ばれる", () => {
    const { hist, factory } = makeFactory({ mean: 1, p50: 1, p99: 1, max: 1 });
    const sampler = new EventLoopLagSampler(factory);
    sampler.enable();
    sampler.snapshot();

    expect(hist.reset).toHaveBeenCalledOnce();

    sampler.disable();
  });

  it("enable() 前に snapshot() を呼ぶとすべて 0 を返す", () => {
    const { factory } = makeFactory({ mean: 99, p50: 99, p99: 99, max: 99 });
    const sampler = new EventLoopLagSampler(factory);
    // enable() を呼ばずに snapshot() する
    const snap = sampler.snapshot();

    expect(snap).toEqual({ mean: 0, p50: 0, p99: 0, max: 0 });
  });

  it(`p99 > ${P99_WARN_THRESHOLD_MS}ms のとき logger.warn が呼ばれる`, async () => {
    const { warn } = await getWarnSpy();
    const { factory } = makeFactory({
      mean: 10,
      p50: 50,
      p99: P99_WARN_THRESHOLD_MS + 1, // 201ms — 閾値超過
      max: 300,
    });
    const sampler = new EventLoopLagSampler(factory);
    sampler.enable();
    sampler.snapshot();

    expect(warn).toHaveBeenCalledOnce();
    const [meta, msg] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(meta.thresholdMs).toBe(P99_WARN_THRESHOLD_MS);
    expect(typeof meta.p99Ms).toBe("number");
    expect(msg).toMatch(/threshold/);

    sampler.disable();
  });

  it(`p99 <= ${P99_WARN_THRESHOLD_MS}ms のとき logger.warn は呼ばれない`, async () => {
    const { warn } = await getWarnSpy();
    const { factory } = makeFactory({
      mean: 5,
      p50: 10,
      p99: P99_WARN_THRESHOLD_MS, // ちょうど 200ms — 超過しない
      max: 210,
    });
    const sampler = new EventLoopLagSampler(factory);
    sampler.enable();
    sampler.snapshot();

    expect(warn).not.toHaveBeenCalled();

    sampler.disable();
  });
});
