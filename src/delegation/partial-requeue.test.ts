import { describe, expect, it, vi } from "vitest";
import {
  MAX_PARTIAL_REQUEUE_DEPTH,
  requeueDepth,
  requeuePartialRun,
  rootRunId,
} from "./partial-requeue.js";

describe("requeuePartialRun", () => {
  it("inherits branch and existing worktree", async () => {
    const invoke = vi.fn(async () => ({ ok: false as const, error: "stop" }));
    await requeuePartialRun({
      run: { id: "old", call_name: "impl", args_json: "{\"x\":1}", spawn_worktree_path: "E:/wt", spawn_cwd: "E:/repo", spawn_branch: "feat/x", parent_session_id: "parent" } as any,
      remaining: [{ title: "finish API", scope_dirs: ["src/api"] }],
      service: { invoke } as any,
    });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ cwd: "E:/wt", branch: "feat/x", worktree: false, args: { x: 1 } }));
  });
});

describe("partial requeue ancestry", () => {
  it("resolves depth and root through a partial-requeue chain", () => {
    const runs = new Map([
      ["root", { id: "root", triggered_by: null }],
      ["parent", { id: "parent", triggered_by: "partial-requeue:root" }],
    ]);
    const run = { id: "current", triggered_by: "partial-requeue:parent" } as any;
    const repo = { findRun: (id: string) => runs.get(id) as any ?? null };

    expect(requeueDepth(run, repo)).toBe(2);
    expect(rootRunId(run, repo)).toBe("root");
  });

  it("stops malformed cyclic ancestry at the traversal limit", () => {
    const run = { id: "cycle", triggered_by: "partial-requeue:cycle" } as any;
    const repo = { findRun: () => run };

    expect(requeueDepth(run, repo)).toBe(MAX_PARTIAL_REQUEUE_DEPTH);
    expect(rootRunId(run, repo)).toBe("cycle");
  });
});
