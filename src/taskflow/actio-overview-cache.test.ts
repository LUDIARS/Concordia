/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-03 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActioOverviewCache } from "./actio-overview-cache.js";
import type { TaskOverviewScan } from "./store.js";
import type { TaskDocument } from "./types.js";

function row(id: string, title = id): TaskDocument {
  return { path: `actio:${id}`, repoPath: "/workspace/cc", body: "", title,
    frontmatter: { task: id, project: "Concordia", kind: "実装", created: "2026-11-25" } };
}

function postponedRead() {
  let finish!: (scan: TaskOverviewScan) => void;
  const promise = new Promise<TaskOverviewScan>((resolve) => { finish = resolve; });
  return { load: vi.fn(() => promise), finish };
}

afterEach(() => vi.useRealTimers());

describe("Actio overview cache", () => {
  it("bounds the cold response and serializes refreshes across scopes", async () => {
    vi.useFakeTimers();
    const cache = new ActioOverviewCache();
    const first = postponedRead();
    const scoped = vi.fn(async () => ({ documents: [row("scoped")] }));
    const cold = cache.read(null, first.load);
    const duplicate = cache.read(null, first.load);
    const project = cache.read("concordia", scoped);
    await vi.advanceTimersByTimeAsync(400);
    for (const read of [cold, duplicate, project]) {
      await expect(read).resolves.toMatchObject({ documents: [], freshness: { fetched_at: null, refreshing: true } });
    }
    expect(first.load).toHaveBeenCalledTimes(1);
    expect(scoped).not.toHaveBeenCalled();

    first.finish({ documents: [row("all")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(scoped).toHaveBeenCalledTimes(1);
    expect((await cache.read("concordia", scoped)).documents).toEqual([row("scoped")]);
    expect((await cache.read(null, first.load)).documents).toEqual([row("all")]);
  });

  it("retains the previous complete snapshot and time through partial reads and timeouts", async () => {
    let now = 0;
    const cache = new ActioOverviewCache(() => now);
    const load = vi.fn<() => Promise<TaskOverviewScan>>()
      .mockResolvedValueOnce({ documents: [row("original")] })
      .mockResolvedValueOnce({ documents: [row("partial")], partialReason: "actio_unreachable" })
      .mockRejectedValueOnce(new Error("Actio read timed out"))
      .mockResolvedValueOnce({ documents: [] });
    const first = await cache.read(null, load);
    expect(first.freshness).toMatchObject({ stale: false, refreshing: false });

    now += 30_000;
    expect((await cache.read(null, load)).freshness).toMatchObject({ stale: true, refreshing: true });
    expect(await cache.read(null, load)).toMatchObject({
      documents: [row("original")],
      freshness: { fetched_at: first.freshness?.fetched_at, stale: true, refresh_error: "actio_unreachable" },
    });

    now += 5_000;
    await cache.read(null, load);
    expect(await cache.read(null, load)).toMatchObject({
      documents: [row("original")], freshness: { refresh_error: "actio_read_timeout" },
    });
    now += 5_000;
    await cache.read(null, load);
    expect(await cache.read(null, load)).toMatchObject({ documents: [], freshness: { stale: false, refresh_error: null } });
  });

  it("keeps a confirmed write visible while an older refresh finishes", async () => {
    let now = 0;
    const cache = new ActioOverviewCache(() => now);
    const original = row("task");
    const updated = row("task", "Updated title");
    const first = await cache.read(null, async () => ({ documents: [original] }));
    const stale = postponedRead();
    now += 30_000;
    await cache.read(null, stale.load);
    cache.record(updated);
    cache.record(row("created"));
    expect(await cache.read(null, stale.load)).toMatchObject({
      documents: [updated, row("created")], freshness: { fetched_at: first.freshness?.fetched_at, stale: true },
    });
    stale.finish({ documents: [original] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const next = postponedRead();
    expect((await cache.read(null, next.load)).documents).toEqual([updated, row("created")]);
    expect(next.load).toHaveBeenCalledTimes(1);
    next.finish({ documents: [updated, row("created")] });
  });

  it("withdraws cached rows when Actio reports an ownership failure", async () => {
    let now = 0;
    const cache = new ActioOverviewCache(() => now);
    await cache.read(null, async () => ({ documents: [row("previously-visible")] }));
    now += 30_000;
    const deny = async () => { throw new Error("Actio task ownership mismatch"); };
    await cache.read(null, deny);
    expect(await cache.read(null, deny)).toMatchObject({
      documents: [], freshness: { fetched_at: null, refresh_error: "actio_scope_denied" },
    });
  });
});
