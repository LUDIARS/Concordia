import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { isWithinWorkspace } from "./repo-context.js";

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
