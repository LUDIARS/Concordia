import { describe, expect, it, vi } from "vitest";
import { cachedActioProjects } from "./actio-projects-cache.js";

describe("cachedActioProjects", () => {
  it("reuses the list within the time to live and reloads after it", async () => {
    let clock = 0;
    const load = vi.fn(async () => [`load-${load.mock.calls.length}`]);
    const read = cachedActioProjects(load, { ttlMs: 1_000, now: () => clock });
    expect(await read()).toEqual(["load-1"]);
    clock = 999;
    expect(await read()).toEqual(["load-1"]);
    expect(load).toHaveBeenCalledTimes(1);
    clock = 1_000;
    expect(await read()).toEqual(["load-2"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent readers", async () => {
    let release!: (value: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>((resolve) => { release = resolve; }));
    const read = cachedActioProjects(load, { now: () => 0 });
    const first = read();
    const second = read();
    release(["p"]);
    expect(await Promise.all([first, second])).toEqual([["p"], ["p"]]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failed load", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("actio_unreachable"))
      .mockResolvedValueOnce(["p"]);
    const read = cachedActioProjects(load as () => Promise<string[]>, { now: () => 0 });
    await expect(read()).rejects.toThrow("actio_unreachable");
    expect(await read()).toEqual(["p"]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
