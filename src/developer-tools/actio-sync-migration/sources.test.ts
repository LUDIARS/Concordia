/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration input over paged lists (CC-TF-SYNC-06, CC-AT-PAGE-01) */
import { describe, expect, it, vi } from "vitest";
import { readActioTasks } from "./sources.js";

const row = (id: string) => ({ id, title: id, description: `本文 ${id}`, projectId: "LP", teamId: null, status: "open",
  source: "concordia.taskflow.v3", pluginPayload: {}, createdAt: "2026-10-11T00:00:00Z", ownerId: "owner" });
const searchOf = (url: string): URLSearchParams => new URL(url).searchParams;

describe("readActioTasks", () => {
  it("reads an older Actio list (no nextCursor) in one request", async () => {
    const get = vi.fn(async () => ({ tasks: [row("a")] }));

    expect((await readActioTasks(get, "http://actio")).map((task) => task.description)).toEqual(["本文 a"]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("opts into descriptions and follows nextCursor of a newer Actio over every page", async () => {
    const get = vi.fn(async (url: string) => searchOf(url).get("cursor") === "c-2"
      ? { tasks: [row("b")], nextCursor: null }
      : { tasks: [row("a")], nextCursor: "c-2" });

    expect((await readActioTasks(get, "http://actio")).map((task) => task.id)).toEqual(["a", "b"]);
    for (const [url] of get.mock.calls) {
      expect(url.startsWith("http://actio/api/tasks?")).toBe(true);
      expect(Object.fromEntries(searchOf(url))).toMatchObject({ scope: "all", include: "description", limit: "500" });
    }
  });
});
