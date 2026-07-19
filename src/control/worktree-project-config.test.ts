import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWorktreeProjectConfig } from "./worktree-project-config.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("worktree project configuration", () => {
  it("copies trust, agent, skill, and MCP configuration but excludes runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-worktree-config-"));
    cleanup.push(root);
    const source = join(root, "project");
    const target = join(root, "project-branch");
    await mkdir(join(source, ".claude", "skills", "local"), { recursive: true });
    await mkdir(join(source, ".claude", "memory"), { recursive: true });
    await mkdir(join(source, ".claude", "state"), { recursive: true });
    await mkdir(join(source, ".agent"), { recursive: true });
    await mkdir(join(source, ".agents", "skills", "shared"), { recursive: true });
    await mkdir(join(source, ".codex"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, ".claude", "settings.local.json"), "{\"trusted\":true}", "utf8");
    await writeFile(join(source, ".claude", "skills", "local", "SKILL.md"), "# local", "utf8");
    await writeFile(join(source, ".claude", "memory", "private.md"), "private", "utf8");
    await writeFile(join(source, ".claude", "state", "session.txt"), "runtime", "utf8");
    await writeFile(join(source, ".agent", "config.json"), "{}", "utf8");
    await writeFile(join(source, ".agents", "skills", "shared", "SKILL.md"), "# shared", "utf8");
    await writeFile(join(source, ".codex", "config.toml"), "project = true", "utf8");
    await writeFile(join(source, ".mcp.json"), "{\"mcpServers\":{}}", "utf8");
    await writeFile(join(source, "mcp.json"), "{\"servers\":{}}", "utf8");

    const result = await copyWorktreeProjectConfig(source, target);

    expect(result.copied).toContain(".claude/settings.local.json");
    expect(result.copied).toContain(".agent/config.json");
    expect(result.copied).toContain(".agents/skills/shared/SKILL.md");
    expect(result.copied).toContain(".codex/config.toml");
    expect(result.copied).toContain(".mcp.json");
    expect(result.copied).toContain("mcp.json");
    expect(await readFile(join(target, ".claude", "skills", "local", "SKILL.md"), "utf8")).toBe("# local");
    await expect(
      readFile(join(target, ".claude", "state", "session.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(target, ".claude", "memory", "private.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an existing worktree-local setting", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-worktree-config-existing-"));
    cleanup.push(root);
    const source = join(root, "project");
    const target = join(root, "project-branch");
    await mkdir(join(source, ".claude"), { recursive: true });
    await mkdir(join(target, ".claude"), { recursive: true });
    await writeFile(join(source, ".claude", "settings.local.json"), "source", "utf8");
    await writeFile(join(target, ".claude", "settings.local.json"), "target", "utf8");

    const result = await copyWorktreeProjectConfig(source, target);

    expect(result.preserved).toEqual([".claude/settings.local.json"]);
    expect(await readFile(join(target, ".claude", "settings.local.json"), "utf8")).toBe("target");
  });
});
