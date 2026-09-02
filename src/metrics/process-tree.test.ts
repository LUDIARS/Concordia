import { describe, expect, it } from "vitest";
import {
  buildProcessIndex,
  sumTreeRss,
  sumTreeRssIndexed,
  topByName,
  type ProcEntry,
} from "./process-tree.js";

/** pid/ppid/rss/name の並びで簡潔に組む。 */
function proc(pid: number, ppid: number, rss: number, name = `p${pid}`): ProcEntry {
  return { pid, ppid, rss, name };
}

describe("buildProcessIndex / sumTreeRssIndexed", () => {
  const procs: ProcEntry[] = [
    proc(1, 0, 100, "root.exe"),
    proc(2, 1, 200, "child.exe"),
    proc(3, 1, 300, "child.exe"),
    proc(4, 2, 400, "grandchild.exe"),
    proc(9, 9, 900, "self-parent.exe"),
  ];

  it("sums the whole subtree from the shared index", () => {
    const index = buildProcessIndex(procs);
    expect(sumTreeRssIndexed(index, 1)).toEqual({ rssBytes: 1000, procCount: 4 });
    expect(sumTreeRssIndexed(index, 2)).toEqual({ rssBytes: 600, procCount: 2 });
    expect(sumTreeRssIndexed(index, 4)).toEqual({ rssBytes: 400, procCount: 1 });
  });

  it("returns zero for an unknown root", () => {
    expect(sumTreeRssIndexed(buildProcessIndex(procs), 12345)).toEqual({ rssBytes: 0, procCount: 0 });
  });

  it("does not treat a self-parent entry as its own child", () => {
    const index = buildProcessIndex(procs);
    expect(index.children.get(9)).toBeUndefined();
    expect(sumTreeRssIndexed(index, 9)).toEqual({ rssBytes: 900, procCount: 1 });
  });

  it("survives a parent/child cycle without looping forever", () => {
    const cyclic: ProcEntry[] = [proc(1, 2, 10), proc(2, 1, 20)];
    expect(sumTreeRssIndexed(buildProcessIndex(cyclic), 1)).toEqual({ rssBytes: 30, procCount: 2 });
  });

  it("stays reusable across roots — the index is read-only", () => {
    const index = buildProcessIndex(procs);
    const first = sumTreeRssIndexed(index, 1);
    sumTreeRssIndexed(index, 2);
    sumTreeRssIndexed(index, 4);
    // 使い回しても最初と同じ結果でなければ索引が破壊されている。
    expect(sumTreeRssIndexed(index, 1)).toEqual(first);
  });

  it("matches the one-shot sumTreeRss helper", () => {
    const index = buildProcessIndex(procs);
    for (const root of [1, 2, 3, 4, 9, 999]) {
      expect(sumTreeRss(procs, root)).toEqual(sumTreeRssIndexed(index, root));
    }
  });
});

describe("topByName", () => {
  it("aggregates rss by image name and returns the top N descending", () => {
    const procs: ProcEntry[] = [
      proc(1, 0, 100, "node.exe"),
      proc(2, 0, 300, "node.exe"),
      proc(3, 0, 500, "claude.exe"),
      proc(4, 0, 50, "tiny.exe"),
    ];
    expect(topByName(procs, 2)).toEqual([
      { name: "claude.exe", rss: 500, count: 1 },
      { name: "node.exe", rss: 400, count: 2 },
    ]);
  });
});
