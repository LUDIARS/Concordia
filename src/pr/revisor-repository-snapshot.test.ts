import { describe, expect, it, vi } from "vitest";
import type { RevisorRepositoryRecord } from "./revisor-repository-client.js";
import { createRevisorRepositorySnapshot } from "./revisor-repository-snapshot.js";

function record(workflow: "revisor" | "github"): RevisorRepositoryRecord {
  return { repository: "LUDIARS/Concordia", rootPath: "E:/Document/Ars/Concordia", baseRef: "main", workflow, testCases: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createRevisorRepositorySnapshot", () => {
  it("waits for the first listing only up to the cold budget", async () => {
    const pending = deferred<RevisorRepositoryRecord[]>();
    const snapshot = createRevisorRepositorySnapshot({ listRepositories: () => pending.promise }, { coldWaitMs: 5 });
    const started = Date.now();
    await expect(snapshot.read()).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
    pending.resolve([record("revisor")]);
    await pending.promise;
    await expect(snapshot.read()).resolves.toEqual([record("revisor")]);
  });

  it("serves the cached listing without waiting and refreshes once in the background when stale", async () => {
    let clock = 0;
    const next = deferred<RevisorRepositoryRecord[]>();
    const listRepositories = vi.fn()
      .mockResolvedValueOnce([record("revisor")])
      .mockReturnValueOnce(next.promise);
    const snapshot = createRevisorRepositorySnapshot({ listRepositories }, { freshMs: 10, now: () => clock });
    await snapshot.read();
    clock = 20;
    // 取り直しが終わっていなくても前回の一覧を即返し、並行 read は 1 本の取得に相乗りする。
    await expect(snapshot.read()).resolves.toEqual([record("revisor")]);
    await expect(snapshot.read()).resolves.toEqual([record("revisor")]);
    expect(listRepositories).toHaveBeenCalledTimes(2);
    next.resolve([record("github")]);
    await next.promise;
    await expect(snapshot.read()).resolves.toEqual([record("github")]);
  });

  it("keeps the last listing on refresh failure until it exceeds the stale limit", async () => {
    let clock = 0;
    const listRepositories = vi.fn()
      .mockResolvedValueOnce([record("revisor")])
      .mockRejectedValue(new Error("revisor down"));
    const snapshot = createRevisorRepositorySnapshot({ listRepositories }, { freshMs: 10, maxStaleMs: 100, now: () => clock });
    await snapshot.read();
    clock = 50;
    await expect(snapshot.read()).resolves.toEqual([record("revisor")]);
    clock = 150;
    await expect(snapshot.read()).resolves.toBeNull();
  });

  it("drops the listing on invalidate and ignores a fetch started before it", async () => {
    const before = deferred<RevisorRepositoryRecord[]>();
    const listRepositories = vi.fn()
      .mockResolvedValueOnce([record("revisor")])
      .mockReturnValueOnce(before.promise)
      .mockResolvedValueOnce([record("github")]);
    let clock = 0;
    const snapshot = createRevisorRepositorySnapshot({ listRepositories }, { freshMs: 10, now: () => clock });
    await snapshot.read();
    clock = 20;
    await snapshot.read(); // 変更前の取得が in-flight のまま残る
    snapshot.invalidate();
    await expect(snapshot.read()).resolves.toEqual([record("github")]);
    before.resolve([record("revisor")]);
    await before.promise;
    await expect(snapshot.read()).resolves.toEqual([record("github")]);
  });
});
