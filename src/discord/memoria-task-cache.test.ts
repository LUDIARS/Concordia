import { describe, expect, it, vi } from "vitest";
import { MemoriaTaskCache, toTaskChoices } from "./memoria-task-cache.js";
import { toTeamChoices } from "./team-choices.js";

const log = { warn: () => {} };

function task(id: number, title: string, category?: string) {
  return { id, title, status: "open", category: category ?? null };
}

describe("MemoriaTaskCache", () => {
  it("waits for the first fetch and serves later calls from cache", async () => {
    let now = 1_000;
    const cache = new MemoriaTaskCache({ ttlMs: 100, now: () => now });
    const source = vi.fn().mockResolvedValue([task(1, "a")]);

    expect(await cache.get(source, log)).toHaveLength(1);
    expect(await cache.get(source, log)).toHaveLength(1);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("serves stale entries immediately once expired and refreshes behind them", async () => {
    let now = 1_000;
    const cache = new MemoriaTaskCache({ ttlMs: 100, now: () => now });
    const source = vi.fn()
      .mockResolvedValueOnce([task(1, "old")])
      .mockResolvedValueOnce([task(2, "new")]);

    await cache.get(source, log);
    now += 500;
    // 期限切れ直後は前回値を返す (Discord の 3 秒制限を待たせない)。
    expect((await cache.get(source, log))[0]?.title).toBe("old");
    await vi.waitFor(() => expect(source).toHaveBeenCalledTimes(2));
    expect((await cache.get(source, log))[0]?.title).toBe("new");
  });

  it("keeps the previous candidates when Memoria is unreachable", async () => {
    let now = 1_000;
    const cache = new MemoriaTaskCache({ ttlMs: 100, now: () => now });
    const source = vi.fn()
      .mockResolvedValueOnce([task(1, "kept")])
      .mockRejectedValue(new Error("ECONNREFUSED"));

    await cache.get(source, log);
    now += 500;
    expect((await cache.get(source, log))[0]?.title).toBe("kept");
  });

  it("returns an empty list when the very first fetch fails", async () => {
    const cache = new MemoriaTaskCache();
    const source = vi.fn().mockRejectedValue(new Error("down"));
    expect(await cache.get(source, log)).toEqual([]);
  });
});

describe("toTaskChoices", () => {
  it("matches on title, category and exact id, capped at the Discord limit", () => {
    const tasks = [task(1, "感想投稿", "GLab"), task(2, "コスト報告", "Cc")];
    expect(toTaskChoices(tasks, "感想").map((c) => c.value)).toEqual(["1"]);
    expect(toTaskChoices(tasks, "cc").map((c) => c.value)).toEqual(["2"]);
    expect(toTaskChoices(tasks, "2").map((c) => c.value)).toEqual(["2"]);
    expect(toTaskChoices(tasks, "")).toHaveLength(2);
    expect(toTaskChoices(Array.from({ length: 40 }, (_, i) => task(i + 1, `t${i}`)), "")).toHaveLength(25);
  });

  it("keeps the label within the Discord length limit", () => {
    const [choice] = toTaskChoices([task(1, "あ".repeat(300))], "");
    expect(choice.name.length).toBeLessThanOrEqual(100);
  });
});

describe("toTeamChoices", () => {
  it("matches name, slug and id and carries the canonical id as the value", () => {
    const teams = [
      { id: "team_a", name: "GLab", slug: "glab" },
      { id: "team_b", name: "Concordia", slug: "cc" },
    ];
    expect(toTeamChoices(teams, "gl").map((c) => c.value)).toEqual(["team_a"]);
    expect(toTeamChoices(teams, "cc").map((c) => c.value)).toEqual(["team_b"]);
    expect(toTeamChoices(teams, "team_a").map((c) => c.value)).toEqual(["team_a"]);
    expect(toTeamChoices(teams, "")[0]?.name).toBe("GLab (glab)");
  });
});
