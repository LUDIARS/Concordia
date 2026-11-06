import { describe, expect, it } from "vitest";
import { readMonitorProgress } from "./monitor-progress.js";

const now = Date.parse("2026-11-06T01:00:00Z");
const report = (extra = {}): string => '```cc-progress\n' + JSON.stringify({
  task: "monitor", percent: 60, evidence: "実装済み、審査待ち", remaining: ["審査"], complete: false,
  at: "2026-11-06T00:55:00Z", ...extra,
}) + '\n```';

describe("readMonitorProgress", () => {
  it("uses an explicit estimate with evidence, not any percent in prose", () => {
    expect(readMonitorProgress("CPU 100%", "monitor", now)).toBeNull();
    expect(readMonitorProgress(report(), "monitor", now)?.percent).toBe(60);
  });
  it.each([{ percent: null }, { percent: -1 }, { percent: 101 }, { evidence: " " },
    { task: "other" }, { at: "2026-11-06T00:00:00Z" }, { at: "2026-11-06T02:00:00Z" },
    { percent: 100 }, { percent: 100, complete: true }, { remaining: "none" }, { at: "invalid" }])(
    "keeps an unsupported estimate unknown (%j)", extra => {
      expect(readMonitorProgress(report(extra), "monitor", now)).toBeNull();
    },
  );
  it("permits zero and completion only when explicitly reported", () => {
    expect(readMonitorProgress(report({ percent: 0 }), "monitor", now)?.percent).toBe(0);
    expect(readMonitorProgress(report({ percent: 100, complete: true, remaining: [] }), "monitor", now)?.percent).toBe(100);
  });
  it("does not fall back to an older valid block after a new invalid report", () => {
    expect(readMonitorProgress(report() + "\n" + report({ percent: null }), "monitor", now)).toBeNull();
  });
});
