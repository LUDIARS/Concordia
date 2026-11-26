import { describe, expect, it, vi } from "vitest";
import {
  continuationArgs,
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

  it("passes the continuation as task when the stored args were sealed into Actio", async () => {
    const invoke = vi.fn(async () => ({ ok: false as const, error: "stop" }));
    await requeuePartialRun({
      run: {
        id: "old", call_name: "sol",
        args_json: JSON.stringify({ target_repo: "E:/repo", taskflow_reference: "actio:t1" }),
        spawn_worktree_path: "E:/wt", spawn_cwd: "E:/repo", spawn_branch: "feat/x", parent_session_id: "parent",
      } as any,
      remaining: [{ title: "finish API" }],
      service: { invoke } as any,
    });
    const call = (invoke.mock.calls[0] as unknown[])[0] as { args: Record<string, unknown>; extra_prompt?: string };
    expect(call.args.target_repo).toBe("E:/repo");
    expect(call.args.taskflow_reference).toBe("actio:t1");
    expect(call.args.task).toEqual(expect.stringContaining("finish API"));
    expect(call.args.task).toEqual(expect.stringContaining("前 run old"));
    expect(call.extra_prompt).toBeUndefined();
  });
});

describe("continuationArgs", () => {
  it("keeps unsealed args and sends the continuation as the extra prompt", () => {
    expect(continuationArgs({ task: "original", target_repo: "E:/r" }, "next"))
      .toEqual({ args: { task: "original", target_repo: "E:/r" }, extraPrompt: "next" });
  });

  it("fills task for sealed args that only carry the Actio reference", () => {
    expect(continuationArgs({ target_repo: "E:/r", taskflow_reference: "actio:t1" }, "next"))
      .toEqual({ args: { target_repo: "E:/r", taskflow_reference: "actio:t1", task: "next" }, extraPrompt: undefined });
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
