/** @implements spec/feature/autonomous-work-continuation.md §2 — HEAD・作業ツリーの観測 */
import { describe, expect, it } from "vitest";
import { observeGitActivity } from "./session-activity-observe.js";

describe("observeGitActivity", () => {
  it("HEAD と未コミット変更を読む", async () => {
    const git = async (_cwd: string, args: string[]) => ({ ok: true, stdout: args[0] === "rev-parse" ? "abc\n" : " M a.ts\n" });
    expect(await observeGitActivity(git, { repo_path: "/r" })).toEqual({ head: "abc", worktree: "M a.ts" });
  });

  it("読めない・例外・repo_path なしは null", async () => {
    expect(await observeGitActivity(async () => ({ ok: false, stdout: "" }), { repo_path: "/r" })).toEqual({ head: null, worktree: null });
    expect(await observeGitActivity(async () => { throw new Error("x"); }, { repo_path: "/r" })).toEqual({ head: null, worktree: null });
    expect(await observeGitActivity(async () => ({ ok: true, stdout: "x" }), { repo_path: "" })).toEqual({ head: null, worktree: null });
  });
});
