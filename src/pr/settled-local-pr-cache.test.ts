import { describe, expect, it, vi } from "vitest";
import { SettledLocalPrCache } from "./settled-local-pr-cache.js";
import type { RevisorLocalPr } from "./revisor-local-pr-types.js";

function pr(id: string, status: string, overrides: Partial<RevisorLocalPr> = {}): RevisorLocalPr {
  return {
    id, number: 1, repository: "LUDIARS/Concordia", title: "t", author: "a", status, checkStatus: "test_ok",
    headRef: "feat/x", baseRef: "main", headSha: "a".repeat(40), createdAt: "2026-11-22T00:00:00Z",
    updatedAt: "2026-11-22T00:00:00Z", sessionId: "s1", labels: ["l"], ...overrides,
  };
}

describe("SettledLocalPrCache (CC-RV-SETTLED-CACHE-01)", () => {
  it("reads a settled PR once and serves later lookups from memory", async () => {
    const cache = new SettledLocalPrCache();
    const load = vi.fn(async (id: string) => pr(id, "merged"));
    expect((await cache.get("p1", load))?.headRef).toBe("feat/x");
    expect((await cache.get("p1", load))?.sessionId).toBe("s1");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each(["open", "queued", ""])("does not remember a PR whose status is %j", async (status) => {
    const cache = new SettledLocalPrCache();
    const load = vi.fn(async (id: string) => pr(id, status));
    await cache.get("p1", load);
    await cache.get("p1", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not remember a missing PR or a failed read, and rethrows the failure", async () => {
    const cache = new SettledLocalPrCache();
    const missing = vi.fn(async () => null);
    expect(await cache.get("gone", missing)).toBeNull();
    expect(await cache.get("gone", missing)).toBeNull();
    expect(missing).toHaveBeenCalledTimes(2);
    const failing = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(pr("p2", "closed"));
    await expect(cache.get("p2", failing)).rejects.toThrow("timeout");
    expect((await cache.get("p2", failing))?.status).toBe("closed");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("does not remember a response whose id differs from the requested one", async () => {
    const cache = new SettledLocalPrCache();
    const load = vi.fn(async () => pr("other", "merged"));
    await cache.get("p1", load);
    await cache.get("p1", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets an entry after the TTL", async () => {
    let now = 0;
    const cache = new SettledLocalPrCache({ ttlMs: 1000, now: () => now });
    const load = vi.fn(async (id: string) => pr(id, "merged"));
    await cache.get("p1", load);
    now = 999;
    await cache.get("p1", load);
    expect(load).toHaveBeenCalledTimes(1);
    now = 1000;
    await cache.get("p1", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops the oldest entries beyond maxEntries", async () => {
    const cache = new SettledLocalPrCache({ maxEntries: 2 });
    const load = vi.fn(async (id: string) => pr(id, "merged"));
    for (const id of ["a", "b", "c"]) await cache.get(id, load);
    expect(cache.size).toBe(2);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("shares one read between concurrent lookups of the same id", async () => {
    const cache = new SettledLocalPrCache();
    let release: (value: RevisorLocalPr) => void = () => undefined;
    const load = vi.fn(() => new Promise<RevisorLocalPr>((resolve) => { release = resolve; }));
    const both = Promise.all([cache.get("p1", load), cache.get("p1", load)]);
    release(pr("p1", "merged"));
    const [first, second] = await both;
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("returns copies so callers cannot change what is remembered", async () => {
    const cache = new SettledLocalPrCache();
    const load = vi.fn(async (id: string) => pr(id, "merged"));
    const first = await cache.get("p1", load);
    first!.headRef = "mutated";
    first!.labels!.push("mutated");
    const second = await cache.get("p1", load);
    expect(second?.headRef).toBe("feat/x");
    expect(second?.labels).toEqual(["l"]);
  });
});
