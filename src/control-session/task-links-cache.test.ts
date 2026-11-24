import { describe, expect, it, vi } from "vitest";
import { createTaskLinksCache } from "./task-links-cache.js";

const item = (status: string) => [{ reference: "actio:1", status, state: "current" as const }];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("Actio の紐付けの読み置き (実装メモ 13)", () => {
  it("answers unavailable after the short wait, keeps reading in the background and serves it next time", async () => {
    const pending = deferred<ReturnType<typeof item>>();
    const read = vi.fn(() => pending.promise);
    const cache = createTaskLinksCache({ read, waitMs: 10 });
    const started = Date.now();
    expect(await cache.get("s1")).toEqual({ state: "unavailable" });
    expect(Date.now() - started).toBeLessThan(200);
    // 待っている間の表示は、同じ読み出しにまとめる。
    expect(await cache.get("s1")).toEqual({ state: "unavailable" });
    expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(item("in_progress"));
    await flush();
    expect(await cache.get("s1")).toEqual({ state: "ok", items: item("in_progress") });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns a quick read directly within the wait", async () => {
    const cache = createTaskLinksCache({ read: async () => item("open"), waitMs: 50 });
    expect(await cache.get("s1")).toEqual({ state: "ok", items: item("open") });
  });

  it("serves the stale value while refreshing, and drops values that are too old", async () => {
    let at = 0;
    let status = "open";
    const read = vi.fn(async () => item(status));
    const cache = createTaskLinksCache({ read, now: () => at, waitMs: 10, freshMs: 100, staleLimitMs: 1000 });
    await cache.get("s1");
    status = "done";
    at = 150;
    expect(await cache.get("s1")).toEqual({ state: "ok", items: item("open") });
    await flush();
    expect(await cache.get("s1")).toEqual({ state: "ok", items: item("done") });
    expect(read).toHaveBeenCalledTimes(2);

    // 引き直しが失敗し続けても、古すぎる値は出さない。
    const stuck = createTaskLinksCache({ read: vi.fn().mockResolvedValueOnce(item("open")).mockReturnValue(new Promise(() => undefined)), now: () => at, waitMs: 10, freshMs: 100, staleLimitMs: 1000 });
    at = 0;
    await stuck.get("s2");
    at = 2000;
    expect(await stuck.get("s2")).toEqual({ state: "unavailable" });
  });

  it("forgets failures, does not retry until the retry interval, and treats null as unavailable", async () => {
    let at = 0;
    const read = vi.fn().mockRejectedValueOnce(new Error("actio down")).mockResolvedValueOnce(null).mockResolvedValue(item("blocked"));
    const cache = createTaskLinksCache({ read, now: () => at, waitMs: 10, retryMs: 100 });
    expect(await cache.get("s1")).toEqual({ state: "unavailable" });
    at = 50;
    expect(await cache.get("s1")).toEqual({ state: "unavailable" });
    expect(read).toHaveBeenCalledTimes(1);
    at = 150;
    expect(await cache.get("s1")).toEqual({ state: "unavailable" });
    at = 300;
    expect(await cache.get("s1")).toEqual({ state: "ok", items: item("blocked") });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("gives up a background read that exceeds the fetch limit", async () => {
    const read = vi.fn(() => new Promise<never>(() => undefined));
    const cache = createTaskLinksCache({ read, waitMs: 5, fetchLimitMs: 20, retryMs: 0 });
    expect(await cache.get("s1")).toEqual({ state: "unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await cache.get("s1");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("forgets sessions that left the board", async () => {
    const read = vi.fn(async () => item("open"));
    const cache = createTaskLinksCache({ read, waitMs: 50 });
    await cache.get("s1");
    cache.retainOnly([]);
    await cache.get("s1");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
