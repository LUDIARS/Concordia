import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRevisorBranchPusher } from "./branch-push.js";

describe("createRevisorBranchPusher", () => {
  it("uses argument arrays and the current Node executable for Revisor push", async () => {
    const calls: Array<{ file: string; args: readonly string[]; cwd: string }> = [];
    const pusher = createRevisorBranchPusher({
      excubitor: {
        findService: async () => ({ catalog_snapshot: { cwd: "E:/Document/Ars/Revisor" } }) as never,
      },
      exec: async (file, args, cwd) => { calls.push({ file, args, cwd }); },
    });

    await pusher.push({
      repoPath: "E:/Document/Ars/Concordia",
      branch: "cc-issue-42",
      actor: "concordia-github-issue:run-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe(process.execPath);
    expect(calls[0].args).toEqual([
      join("E:/Document/Ars/Revisor", "src", "cli.mjs"),
      "push",
      "--repo", "E:/Document/Ars/Concordia",
      "--branch", "cc-issue-42",
      "--actor", "concordia-github-issue:run-1",
    ]);
    expect(calls[0].cwd).toBe("E:/Document/Ars/Concordia");
  });
});
