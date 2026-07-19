import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionSkillSources, loadSessionSkill } from "./session-skill-source.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Session branch skill sources", () => {
  it("reads repo-local and authored skills only from the Session worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "cc-skill-"));
    cleanup.push(repo);
    await mkdir(join(repo, ".claude", "skills", "branch-only"), { recursive: true });
    await writeFile(join(repo, ".claude", "skills", "branch-only", "SKILL.md"), "# branch skill", "utf8");
    await mkdir(join(repo, "src", "skills"), { recursive: true });
    await writeFile(join(repo, "src", "skills", "concordia.md"), "# authored", "utf8");

    expect(await listSessionSkillSources(repo)).toEqual([
      { name: "branch-only", relativePath: ".claude/skills/branch-only/SKILL.md" },
      { name: "concordia", relativePath: "src/skills/concordia.md" },
    ]);
    expect((await loadSessionSkill(repo, "branch-only"))?.content).toBe("# branch skill");
  });

  it("rejects traversal-like names", async () => {
    const repo = await mkdtemp(join(tmpdir(), "cc-skill-safe-"));
    cleanup.push(repo);
    expect(await loadSessionSkill(repo, "../outside")).toBeNull();
  });
});
