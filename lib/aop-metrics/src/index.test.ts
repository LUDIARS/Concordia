import { describe, expect, it } from "vitest";
import {
  FunctionMetricAggregator,
  createFunctionMetricRuntime,
  wrapFunction,
  wrapMethod,
} from "./index.js";

describe("@ludiars/aop-metrics", () => {
  it("wraps synchronous functions and aggregates calls", () => {
    let t = 100;
    const records: unknown[] = [];
    const measured = wrapFunction((n: number) => n * 2, {
      service: "svc",
      target: "math.double",
      kind: "unit",
      now: () => {
        t += 5;
        return t;
      },
      report: (r) => records.push(r),
    });

    expect(measured(3)).toBe(6);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      service: "svc",
      target: "math.double",
      status: "ok",
      durationMs: 5,
    });
    expect(records[0]).not.toHaveProperty("errorName");
  });

  it("records async failures without swallowing the error", async () => {
    let t = 0;
    const aggregator = new FunctionMetricAggregator({ now: () => t });
    const runtime = createFunctionMetricRuntime({
      service: "svc",
      now: () => {
        t += 10;
        return t;
      },
      aggregator,
    });
    const measured = runtime.wrapFunction("async.fail", async () => {
      throw new TypeError("boom");
    });

    await expect(measured()).rejects.toThrow("boom");
    const row = aggregator.snapshot().rows[0]!;
    expect(row).toMatchObject({
      service: "svc",
      target: "async.fail",
      calls: 1,
      errors: 1,
      maxMs: 10,
      errorNames: { TypeError: 1 },
    });
  });

  it("overwrites and restores object methods", () => {
    const aggregator = new FunctionMetricAggregator();
    const owner = {
      value: 2,
      inc(n: number) {
        return this.value + n;
      },
    };
    const restore = wrapMethod(owner, "inc", {
      service: "svc",
      target: "owner.inc",
      report: (record) => aggregator.record(record),
    });

    expect(owner.inc(3)).toBe(5);
    expect(aggregator.snapshot().rows[0]).toMatchObject({ calls: 1, errorNames: {} });
    restore.restore();
    expect(owner.inc.name).toBe("inc");
  });
});
