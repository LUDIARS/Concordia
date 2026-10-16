import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isWithinWorkspace, inspectImplementationRepo } from "./repo-context.js";

describe("isWithinWorkspace", () => {
  it("accepts a configured workspace and rejects a sibling path", async () => {
    const parent = await mkdtemp(join(tmpdir(), "concordia-workspace-"));
    const workspace = join(parent, "workspace");
    const sibling = join(parent, "workspace-sibling");
    const anotherWorkspace = join(parent, "another-workspace");
    await Promise.all([
      mkdir(join(workspace, "Concordia"), { recursive: true }),
      mkdir(sibling),
      mkdir(anotherWorkspace),
    ]);
    try {
      await expect(isWithinWorkspace(join(workspace, "Concordia"), [workspace])).resolves.toBe(true);
      await expect(isWithinWorkspace(sibling, [workspace])).resolves.toBe(false);
      await expect(isWithinWorkspace(anotherWorkspace, [workspace, anotherWorkspace])).resolves.toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("repository inspection", () => {
  const root = join(tmpdir(), "binding-fixture");
  it("preserves the selected checkout instead of the launching workspace", async () => {
    const context = await inspectImplementationRepo(root, async (_cwd, args) =>
      args[0] === "rev-parse" ? root : args[0] === "branch" ? "feat/fix" : "https://github.com/example/game.git");
    expect(context).toEqual({ repoPath: root, branch: "feat/fix", repoOrigin: "https://github.com/example/game.git" });
  });
  it("does not turn origin inspection failure into an absent origin", async () => {
    await expect(inspectImplementationRepo(root, async (_cwd, args) => {
      if (args[0] === "config") throw new Error("origin lookup failed");
      return args[0] === "rev-parse" ? root : "feat/fix";
    })).rejects.toThrow("origin lookup failed");
  });
  it("refuses an unnamed branch before updating a session", async () => {
    await expect(inspectImplementationRepo(root, async (_cwd, args) => args[0] === "rev-parse" ? root : ""))
      .rejects.toMatchObject({ reason: "unnamed_branch", stage: "repository" });
  });
});
