import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runConfluxBuild } from "./build-runner.js";

it("builds the verified flow commit in an isolated checkout and removes it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cc-conflux-test-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=.", ...args], { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("switch", "-q", "-c", "evolution/tide/variant");
    writeFileSync(join(repo, "input.txt"), "committed");
    git("add", "input.txt");
    git("commit", "-q", "-m", "flow");
    const sha = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "input.txt"), "shared checkout edit");
    const runner = join(repo, "fixture.mjs");
    writeFileSync(runner, `
      import { readFileSync, writeFileSync } from "node:fs";
      const { commit, platforms } = JSON.parse(process.argv[2]);
      if (readFileSync("input.txt", "utf8") !== "committed" || commit !== "${sha}" || platforms[0] !== "web") process.exit(2);
      writeFileSync("artifact.txt", "build output");
    `);
    const job = { project_code: "Cc", projectCode: "cf", variantId: "id", dedupe_key: "key",
      tide: "tide", variant: "variant", commit: sha.slice(0, 10), platforms: ["web"] };
    const initial = git("status", "--porcelain");
    await runConfluxBuild(repo, runner, job, new AbortController().signal);
    expect(git("status", "--porcelain")).toBe(initial);
    expect(git("worktree", "list").split(/\r?\n/)).toHaveLength(1);
    await expect(runConfluxBuild(repo, runner, { ...job, branch: "evolution/tide/variant/main" }, new AbortController().signal))
      .rejects.toThrow("Conflux mainline is missing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}, 20_000);
