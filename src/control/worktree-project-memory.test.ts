import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeProjectKey,
  copyWorktreeProjectMemory,
} from "./worktree-project-memory.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worktree project memory", () => {
  it("uses the same absolute cwd key format as Lictor", () => {
    expect(claudeProjectKey("E:\\Document\\Ars\\Concordia")).toBe("E--Document-Ars-Concordia");
  });

  it("places only the primary project's Markdown memory under the worktree key", async () => {
    const home = await mkdtemp(join(tmpdir(), "cc-worktree-memory-"));
    cleanup.push(home);
    const source = "E:/Document/Ars/Concordia";
    const target = "E:/Document/Ars/Concordia-fix";
    const sourceDir = join(home, ".claude", "projects", claudeProjectKey(source), "memory");
    const targetDir = join(home, ".claude", "projects", claudeProjectKey(target), "memory");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "MEMORY.md"), "# Concordia", "utf8");
    await writeFile(join(sourceDir, "project_concordia.md"), "Cc memory", "utf8");
    await writeFile(join(sourceDir, "runtime.json"), "{}", "utf8");

    const result = await copyWorktreeProjectMemory(source, target, { homeRoot: home });

    expect(result.copied).toEqual(["MEMORY.md", "project_concordia.md"]);
    expect(await readFile(join(targetDir, "project_concordia.md"), "utf8")).toBe("Cc memory");
    await expect(readFile(join(targetDir, "runtime.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves memory already updated for the worktree", async () => {
    const home = await mkdtemp(join(tmpdir(), "cc-worktree-memory-existing-"));
    cleanup.push(home);
    const source = "E:/Document/Ars/Memoria";
    const target = "E:/Document/Ars/Memoria-feature";
    const sourceDir = join(home, ".claude", "projects", claudeProjectKey(source), "memory");
    const targetDir = join(home, ".claude", "projects", claudeProjectKey(target), "memory");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(sourceDir, "project_memoria.md"), "source", "utf8");
    await writeFile(join(targetDir, "project_memoria.md"), "worktree", "utf8");

    const result = await copyWorktreeProjectMemory(source, target, { homeRoot: home });

    expect(result.preserved).toEqual(["project_memoria.md"]);
    expect(await readFile(join(targetDir, "project_memoria.md"), "utf8")).toBe("worktree");
  });
});
