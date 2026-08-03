/**
 * function metric の Vg 書き込み方針 (spec/feature/runtime-function-metrics.md — Vestigium 出力):
 *  - per-record ストリームは error のみ (既定)
 *  - ok は in-memory 集計に畳み、 集約サマリ 1 行で出す
 *  - 前回サマリから新規 call が無ければサマリも出さない
 *
 * @implements spec/feature/runtime-function-metrics.md — Vestigium 出力
 */

import { afterAll, describe, it, expect, beforeEach, vi } from "vitest";

const { vgWrite } = vi.hoisted(() => ({ vgWrite: vi.fn() }));

vi.mock("../src/shared/vestigium.js", () => ({
  vgWrite,
  vgEnabled: () => false,
  vgShutdown: async () => {},
}));

// Revisor など親プロセスが metrics を無効化 / 全record ストリーム化していても、
// このテストは既定 (有効 + error のみ per-record) の出力契約そのものを検証する。
// instrumentation は import 時に env を読んで確定するので、 module cache を切ってから
// 関与する env を両方固定し、 終了時に親の環境へ戻す。
// Node は undefined 代入を "undefined" 文字列にするので、 pin 値は必ず string で持つ。
const pinnedEnv: Record<string, string> = {
  // 有効化 (無効判定は "0" のみ)
  CONCORDIA_AOP_METRICS: "1",
  // 旧挙動 (全record per-record ストリーム) を明示的に切る
  CONCORDIA_AOP_METRICS_STREAM: "0",
};
// 明示注釈がないと Object.fromEntries の `Iterable<readonly any[]>` overload に落ちて
// originalEnv が any になり、 復元ループの undefined 判定が型検査されなくなる。
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
  Object.keys(pinnedEnv).map((key) => [key, process.env[key]] as const),
);
for (const [key, value] of Object.entries(pinnedEnv)) process.env[key] = value;
vi.resetModules();

const {
  emitMetricSummary,
  instrumentConcordiaFunction,
  recordEventLoopStall,
  resetFunctionMetrics,
} = await import("../src/instrumentation.js");

afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

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
