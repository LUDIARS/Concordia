import { describe, expect, it, vi } from "vitest";
import { createTtlMemo } from "./ttl-memo.js";

describe("createTtlMemo", () => {
  it("computes once and shares the value inside the TTL", () => {
    let now = 1_000;
    const compute = vi.fn(() => ({ n: 1 }));
    const get = createTtlMemo<{ n: number }>(500, () => now);

    const first = get(compute);
    now = 1_499;
    const second = get(compute);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("recomputes after the TTL elapses", () => {
    let now = 1_000;
    let seq = 0;
    const compute = vi.fn(() => ++seq);
    const get = createTtlMemo<number>(500, () => now);

    expect(get(compute)).toBe(1);
    now = 1_500;
    expect(get(compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("force-refreshes and replaces the cached value inside the TTL", () => {
    let now = 1_000;
    let seq = 0;
    const compute = vi.fn(() => ++seq);
    const get = createTtlMemo<number>(10_000, () => now);

    expect(get(compute)).toBe(1);
    expect(get(compute, true)).toBe(2);
    expect(get(compute)).toBe(2);
  });

  it("caches falsy values instead of recomputing them", () => {
    const compute = vi.fn(() => 0);
    const get = createTtlMemo<number>(500, () => 1_000);

    get(compute);
    get(compute);

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid TTL %s", (ttlMs) => {
    expect(() => createTtlMemo(ttlMs)).toThrow(RangeError);
  });
});
