/**
 * function metric の Vg 書き込み方針 (spec/feature/runtime-function-metrics.md — Vestigium 出力):
 *  - per-record ストリームは error のみ (既定)
 *  - ok は in-memory 集計に畳み、 集約サマリ 1 行で出す
 *  - 前回サマリから新規 call が無ければサマリも出さない
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { vgWrite } = vi.hoisted(() => ({ vgWrite: vi.fn() }));

vi.mock("../src/shared/vestigium.js", () => ({
  vgWrite,
  vgEnabled: () => false,
  vgShutdown: async () => {},
}));

import {
  emitMetricSummary,
  instrumentConcordiaFunction,
  recordEventLoopStall,
  resetFunctionMetrics,
} from "../src/instrumentation.js";

function messages(): string[] {
  return vgWrite.mock.calls.map((call) => String(call[1]));
}

describe("function metric の Vg 書き込み", () => {
  beforeEach(() => {
    resetFunctionMetrics();
    vgWrite.mockClear();
  });

  it("ok レコードは per-record で流さない", () => {
    const wrapped = instrumentConcordiaFunction("test.ok", () => 1);
    wrapped();
    expect(messages()).not.toContain("lapilli.function_metric");
  });

  it("error レコードは per-record で流す", () => {
    recordEventLoopStall({ lagMs: 1200, activeHandles: 3, activeRequests: 0 });
    expect(messages()).toContain("lapilli.function_metric");
  });

  it("集約サマリは累計 totals と当該 interval の増分を出す", () => {
    const wrapped = instrumentConcordiaFunction("test.summary", () => 1);
    wrapped();
    wrapped();
    emitMetricSummary();

    const summary = vgWrite.mock.calls.find((call) => call[1] === "lapilli.function_metric.summary");
    expect(summary).toBeDefined();
    const ctx = summary?.[2] as {
      since_last_calls: number;
      totals: { calls: number };
      top: Array<{ target: string; calls: number }>;
    };
    expect(ctx.since_last_calls).toBe(2);
    expect(ctx.totals.calls).toBe(2);
    expect(ctx.top.some((row) => row.target === "test.summary" && row.calls === 2)).toBe(true);
  });

  it("新規 call が無ければサマリを出さない", () => {
    const wrapped = instrumentConcordiaFunction("test.idle", () => 1);
    wrapped();
    emitMetricSummary();
    vgWrite.mockClear();

    emitMetricSummary();
    expect(messages()).not.toContain("lapilli.function_metric.summary");
  });
});
