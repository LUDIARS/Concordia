import { describe, expect, it } from "vitest";
import { WorkReposCache } from "./repo-list-cache.js";
import type { RepoStatus } from "./repo-scan.js";

describe("WorkReposCache", () => {
  it("returns immediately on a cold cache while one refresh runs", async () => {
    let calls = 0;
    let release!: (repos: RepoStatus[]) => void;
    const cache = new WorkReposCache({
      sessions: {} as never,
      initialWaitMs: 0,
      refreshDelayMs: 0,
      fetcher: async () => {
        calls += 1;
        return await new Promise<RepoStatus[]>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = await cache.get(["/repo-root"]);
    expect(first.cache.source).toBe("empty");
    expect(first.refreshing).toBe(true);
    expect(first.repos).toEqual([]);

    const second = await cache.get(["/repo-root"]);
    expect(second.cache.source).toBe("empty");
    expect(calls).toBe(1);

    release([repo("Concordia")]);
    await tick();

    const cached = await cache.get(["/repo-root"]);
    expect(cached.cache.source).toBe("l1");
    expect(cached.refreshing).toBe(false);
    expect(cached.repos.map((r) => r.name)).toEqual(["Concordia"]);
  });

  it("serves stale data and deduplicates background refreshes", async () => {
    let now = 1_000;
    let calls = 0;
    const queued: Array<(repos: RepoStatus[]) => void> = [];
    const cache = new WorkReposCache({
      sessions: {} as never,
      ttlMs: 10,
      staleMs: 1_000,
      initialWaitMs: 5,
      refreshDelayMs: 0,
      now: () => now,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) return [repo("first")];
        return await new Promise<RepoStatus[]>((resolve) => queued.push(resolve));
      },
    });

    const fresh = await cache.get(["/repo-root"]);
    expect(fresh.cache.source).toBe("fresh");
    expect(fresh.repos.map((r) => r.name)).toEqual(["first"]);

    now += 20;
    const stale = await cache.get(["/repo-root"]);
    expect(stale.cache.source).toBe("stale");
    expect(stale.refreshing).toBe(true);
    expect(stale.repos.map((r) => r.name)).toEqual(["first"]);

    const stillStale = await cache.get(["/repo-root"]);
    expect(stillStale.cache.source).toBe("stale");
    expect(calls).toBe(2);

    queued[0]?.([repo("second")]);
    await tick();

    const refreshed = await cache.get(["/repo-root"]);
    expect(refreshed.cache.source).toBe("l1");
    expect(refreshed.repos.map((r) => r.name)).toEqual(["second"]);
  });
});

function repo(name: string): RepoStatus {
  return {
    name,
    path: `/repo-root/${name}`,
    branch: "main",
    detached: false,
    is_worktree: false,
    default_branch: "main",
    on_default_branch: true,
    worktrees: [],
    extra_worktree_count: 0,
    updated_at: null,
    sessions: [],
    error: null,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
