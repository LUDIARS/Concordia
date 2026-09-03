import { describe, expect, it, vi } from "vitest";

import { SharedReadCache } from "./revisor-read-cache.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("SharedReadCache", () => {
  it("collapses concurrent gets of the same key into one load", async () => {
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);
    const cache = new SharedReadCache({ ttlMs: 1000, now: () => 0 });

    const all = Promise.all([cache.get("a", load), cache.get("a", load), cache.get("a", load)]);
    gate.resolve("value");

    expect(await all).toEqual(["value", "value", "value"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reuses the result inside the TTL and reloads after it", async () => {
    let now = 0;
    const load = vi.fn(async () => `v${load.mock.calls.length}`);
    const cache = new SharedReadCache({ ttlMs: 100, now: () => now });

    expect(await cache.get("a", load)).toBe("v1");
    now = 99;
    expect(await cache.get("a", load)).toBe("v1");
    now = 100;
    expect(await cache.get("a", load)).toBe("v2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries independently", async () => {
    const cache = new SharedReadCache({ ttlMs: 1000, now: () => 0 });
    expect(await cache.get("a", async () => "A")).toBe("A");
    expect(await cache.get("b", async () => "B")).toBe("B");
    expect(await cache.get("a", async () => "other")).toBe("A");
  });

  it("does not cache failures and propagates them to every joiner", async () => {
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);
    const cache = new SharedReadCache({ ttlMs: 1000, now: () => 0 });

    const first = cache.get("a", load);
    const second = cache.get("a", load);
    gate.reject(new Error("upstream down"));

    await expect(first).rejects.toThrow("upstream down");
    await expect(second).rejects.toThrow("upstream down");
    expect(await cache.get("a", async () => "recovered")).toBe("recovered");
  });

  it("invalidate drops the cached value and discards an in-flight result", async () => {
    const gate = deferred<string>();
    const cache = new SharedReadCache({ ttlMs: 1000, now: () => 0 });

    const stale = cache.get("a", () => gate.promise);
    cache.invalidate("a");
    gate.resolve("stale");
    expect(await stale).toBe("stale");

    expect(await cache.get("a", async () => "fresh")).toBe("fresh");
  });

  it("invalidate without a key clears everything", async () => {
    const cache = new SharedReadCache({ ttlMs: 1000, now: () => 0 });
    await cache.get("a", async () => "A");
    await cache.get("b", async () => "B");
    cache.invalidate();
    expect(await cache.get("a", async () => "A2")).toBe("A2");
    expect(await cache.get("b", async () => "B2")).toBe("B2");
  });

  it("with a non-positive TTL still collapses concurrent loads but never reuses", async () => {
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);
    const cache = new SharedReadCache({ ttlMs: 0, now: () => 0 });

    const all = Promise.all([cache.get("a", load), cache.get("a", load)]);
    gate.resolve("value");
    await all;
    expect(load).toHaveBeenCalledTimes(1);

    await cache.get("a", async () => "again");
    expect(await cache.get("a", async () => "again2")).toBe("again2");
  });
});
