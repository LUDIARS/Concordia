import { describe, it, expect } from "vitest";
import {
  parseWindowsProcs,
  parsePosixProcs,
  procEntriesFromSnapshot,
  sumTreeRss,
  topByName,
  type ProcEntry,
} from "../src/metrics/process-tree.js";

describe("process-tree parse", () => {
  it("Windows CSV pid,ppid,ws,name", () => {
    const e = parseWindowsProcs("100,4,1048576,node.exe\r\n200,100,2048,cmd.exe\r\nbad");
    expect(e).toEqual([
      { pid: 100, ppid: 4, rss: 1048576, name: "node.exe" },
      { pid: 200, ppid: 100, rss: 2048, name: "cmd.exe" },
    ]);
  });
  it("POSIX rss(KB)→bytes", () => {
    const e = parsePosixProcs("  100   4  1024 node\n  200 100  512 npm");
    expect(e[0]).toEqual({ pid: 100, ppid: 4, rss: 1024 * 1024, name: "node" });
  });
});

describe("Excubitor process snapshot", () => {
  it("wire model をメトリクス用 ProcEntry に変換する", () => {
    expect(procEntriesFromSnapshot({
      sampled_at: 1000,
      processes: [{
        pid: 100,
        ppid: 4,
        rss: 1024,
        cpu_ms: 2,
        name: "node.exe",
        started_at: 500,
        command_line: "node app.js",
      }],
    })).toEqual([{ pid: 100, ppid: 4, rss: 1024, name: "node.exe" }]);
  });
});

describe("sumTreeRss", () => {
  const procs: ProcEntry[] = [
    { pid: 100, ppid: 1, rss: 100, name: "cmd" },
    { pid: 200, ppid: 100, rss: 200, name: "node" },
    { pid: 300, ppid: 200, rss: 300, name: "claude" },
    { pid: 999, ppid: 1, rss: 999, name: "other" },
  ];
  it("部分木を合算", () => {
    expect(sumTreeRss(procs, 100)).toEqual({ rssBytes: 600, procCount: 3 });
  });
  it("存在しない pid は 0", () => {
    expect(sumTreeRss(procs, 4242)).toEqual({ rssBytes: 0, procCount: 0 });
  });
  it("cycle で無限ループしない", () => {
    const cyc: ProcEntry[] = [
      { pid: 2, ppid: 3, rss: 20, name: "a" },
      { pid: 3, ppid: 2, rss: 30, name: "b" },
    ];
    expect(sumTreeRss(cyc, 2)).toEqual({ rssBytes: 50, procCount: 2 });
  });
});

describe("topByName", () => {
  it("image 名で合算し降順", () => {
    const procs: ProcEntry[] = [
      { pid: 1, ppid: 0, rss: 100, name: "node" },
      { pid: 2, ppid: 0, rss: 200, name: "node" },
      { pid: 3, ppid: 0, rss: 50, name: "cmd" },
    ];
    const top = topByName(procs, 5);
    expect(top[0]).toEqual({ name: "node", rss: 300, count: 2 });
    expect(top[1]).toEqual({ name: "cmd", rss: 50, count: 1 });
  });
});
