/** @implements spec/feature/task-workflow-v3.md CC-AT-PAGE-01 CC-AT-PAGE-02 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ACTIO_TASK_PAGE_LIMIT, actioTaskPagePath, actioTaskPages, nextActioTaskCursor, readAllActioTasks,
} from "./actio-task-pages.js";

const Item = z.object({ id: z.string() });
const query = (): URLSearchParams => new URLSearchParams({ scope: "all", pluginId: "concordia" });
const params = (path: string): URLSearchParams => new URLSearchParams(path.slice("/api/tasks?".length));

describe("actioTaskPagePath", () => {
  it("keeps the caller's filters and adds the page size without a cursor on the first page", () => {
    const path = actioTaskPagePath(query(), null);
    expect(path.startsWith("/api/tasks?")).toBe(true);
    expect(Object.fromEntries(params(path))).toEqual({ scope: "all", pluginId: "concordia", limit: String(ACTIO_TASK_PAGE_LIMIT) });
  });
  it("adds the cursor only when continuing", () => {
    expect(params(actioTaskPagePath(query(), "c-2")).get("cursor")).toBe("c-2");
  });
});

describe("nextActioTaskCursor", () => {
  it("treats a missing, null or empty cursor as the last page", () => {
    expect(nextActioTaskCursor({})).toBeNull();
    expect(nextActioTaskCursor({ nextCursor: null })).toBeNull();
    expect(nextActioTaskCursor({ nextCursor: "" })).toBeNull();
    expect(nextActioTaskCursor({ nextCursor: "c-2" })).toBe("c-2");
  });
});

describe("readAllActioTasks", () => {
  it("reads an older Actio response (no nextCursor, full rows) as a single page", async () => {
    const fetchPage = vi.fn(async () => ({ tasks: [{ id: "a", description: "本文" }, { id: "b", description: null }] }));
    expect(await readAllActioTasks(fetchPage, query(), Item)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
  it("follows nextCursor across pages of a newer Actio until it is null", async () => {
    const pages: Record<string, unknown> = {
      "": { tasks: [{ id: "a" }], nextCursor: "c-2" },
      "c-2": { tasks: [{ id: "b" }], nextCursor: "c-3" },
      "c-3": { tasks: [{ id: "c" }], nextCursor: null },
    };
    const fetchPage = vi.fn(async (path: string) => pages[params(path).get("cursor") ?? ""]);
    expect((await readAllActioTasks(fetchPage, query(), Item)).map((task) => task.id)).toEqual(["a", "b", "c"]);
    expect(fetchPage.mock.calls.map(([path]) => params(path).get("cursor"))).toEqual([null, "c-2", "c-3"]);
  });
  it("refuses a repeated cursor instead of looping", async () => {
    const fetchPage = vi.fn(async () => ({ tasks: [{ id: "a" }], nextCursor: "same" }));
    await expect(readAllActioTasks(fetchPage, query(), Item)).rejects.toThrow("cursor repeated");
  });
  it("refuses a response without a task array", async () => {
    await expect(readAllActioTasks(async () => ({ items: [] }), query(), Item)).rejects.toThrow("Invalid Actio task list response");
  });
  it("lets a consumer stop reading once it found what it needs", async () => {
    const fetchPage = vi.fn(async (path: string) => params(path).has("cursor")
      ? { tasks: [{ id: "b" }], nextCursor: null } : { tasks: [{ id: "a" }], nextCursor: "c-2" });
    for await (const page of actioTaskPages(fetchPage, query(), Item)) if (page.some((task) => task.id === "a")) break;
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
