import { describe, expect, it, vi } from "vitest";
import { requeuePartialRun } from "./partial-requeue.js";

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
