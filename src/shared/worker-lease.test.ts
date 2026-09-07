import { afterEach, describe, expect, it, vi } from "vitest";
import { startWorkerLease, type WorkerLeaseRepo } from "./worker-lease.js";

function repoHarness(): { repo: WorkerLeaseRepo; values: Map<string, string>; failCas: () => void } {
  const values = new Map<string, string>();
  let shouldFail = false;
  return {
    values,
    failCas: () => { shouldFail = true; },
    repo: {
      get: (key) => values.get(key) ?? null,
      compareAndSwap: (key, expected, value) => {
        if (shouldFail) throw new Error("db unavailable");
        if ((values.get(key) ?? null) !== expected) return false;
        if (value === null) values.delete(key);
        else values.set(key, value);
        return true;
      },
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("startWorkerLease ownership loss", () => {
  it("reports replacement immediately when heartbeat CAS no longer owns the row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const h = repoHarness();
    const handle = startWorkerLease(h.repo, {
      key: "worker",
      role: "test",
      heartbeatMs: 10,
      ttlMs: 100,
      now: Date.now,
      owner: "old",
    });
    h.values.set("worker", JSON.stringify({ ...handle.lease, owner: "new" }));

    const lost = handle.lost;
    await vi.advanceTimersByTimeAsync(10);

    await expect(lost).resolves.toBe("replaced");
    expect(handle.owns()).toBe(false);
  });

  it("expires locally when heartbeat storage errors continue through the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const h = repoHarness();
    const handle = startWorkerLease(h.repo, {
      key: "worker",
      role: "test",
      heartbeatMs: 10,
      ttlMs: 50,
      now: Date.now,
      owner: "old",
    });
    h.failCas();

    const lost = handle.lost;
    await vi.advanceTimersByTimeAsync(50);

    await expect(lost).resolves.toBe("expired");
    expect(handle.owns()).toBe(false);
  });
});
