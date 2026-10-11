/** @implements spec/feature/task-workflow-v3.md — Actio task sync: runs to task many-to-one (CC-TF-SYNC-03) */

import { describe, expect, it } from "vitest";
import { appendTaskInstruction, endTaskRun, startTaskRun, taskRuns } from "./task-runs.js";

describe("task run records", () => {
  it("appends runs and closes an unfinished predecessor as superseded", () => {
    const first = startTaskRun({ kind: "実装" }, { runId: "r1", sessionId: null, at: "t1" });
    const second = startTaskRun(first, { runId: "r2", sessionId: "s2", at: "t2" });
    expect(second.kind).toBe("実装");
    expect(taskRuns(second)).toEqual([
      { run_id: "r1", session_id: null, started_at: "t1", ended_at: "t2", end_reason: "superseded" },
      { run_id: "r2", session_id: "s2", started_at: "t2", ended_at: null },
    ]);
  });

  it("is idempotent for a retried start and only closes an open run once", () => {
    const started = startTaskRun(null, { runId: "r1", sessionId: null, at: "t1" });
    expect(startTaskRun(started, { runId: "r1", sessionId: null, at: "t9" })).toEqual(started);
    const ended = endTaskRun(started, { runId: "r1", at: "t2", reason: "completed" });
    expect(taskRuns(ended)[0]).toMatchObject({ ended_at: "t2", end_reason: "completed" });
    expect(endTaskRun(ended, { runId: "r1", at: "t3", reason: "failed" })).toEqual(ended);
    expect(endTaskRun(ended, { runId: "unknown", at: "t3", reason: "failed" })).toEqual(ended);
  });

  it("ignores a malformed runs field instead of failing the task", () => {
    expect(taskRuns({ runs: "broken" })).toEqual([]);
  });

  it("appends a new instruction once and keeps the original body", () => {
    const body = appendTaskInstruction("元の本文", "r2", "前任の続きを引き継ぐ");
    expect(body).toBe("元の本文\n\n---\n\n## 続きの指示 (run r2)\n\n前任の続きを引き継ぐ");
    expect(appendTaskInstruction(body, "r3", "前任の続きを引き継ぐ")).toBe(body);
    expect(appendTaskInstruction("元の本文", "r2", "元の本文")).toBe("元の本文");
  });
});
