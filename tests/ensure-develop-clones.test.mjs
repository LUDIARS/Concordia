import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDevelopClones,
  findMainRepositories,
  parseArgs,
  runGit,
} from "../tools/ensure-develop-clones.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "concordia-develop-clones-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd, ...args) {
  return runGit(cwd, [
    "-c",
    "user.name=Concordia Test",
    "-c",
    "user.email=concordia-test@example.invalid",
    ...args,
  ]);
}

function createRepository(root, name = "Repo") {
  const remote = join(root, `${name}.git-remote`);
  const repository = join(root, name);
  mkdirSync(remote);
  git(remote, "init", "--bare");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  mkdirSync(repository);
  git(repository, "init");
  git(repository, "symbolic-ref", "HEAD", "refs/heads/main");
  git(repository, "config", "core.hooksPath", "NUL");
  git(repository, "config", "core.fsmonitor", "false");
  // User-level Git templates may install Git LFS hooks. The test remote is local
  // and intentionally exercises plain Git only.
  rmSync(join(repository, ".git", "hooks"), { recursive: true, force: true });
  mkdirSync(join(repository, ".git", "hooks"));
  writeFileSync(join(repository, "README.md"), `${name}\n`, "utf8");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  git(repository, "remote", "add", "origin", pathToFileURL(remote).href);
  git(repository, "push", "-u", "origin", "main");
  return { remote, repository };
}

function capture() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

describe("ensure-develop-clones", () => {
  it("defaults to dry-run and parses exclusions", () => {
    const parsed = parseArgs(["--root", "E:/work", "--exclude", "One, Two"]);
    expect(parsed.apply).toBe(false);
    expect(parsed.excluded).toEqual(new Set(["one", "two"]));
  });

  it("dry-run reports the plan without creating a branch or clone", async () => {
    const root = createWorkspace();
    const { remote } = createRepository(root, "Alpha");
    const output = capture();

    const summary = await ensureDevelopClones({ root, write: output.write });

    expect(output.lines[0]).toContain("[create-branch,clone] Alpha: develop <- origin/main");
    expect(summary).toMatchObject({ targets: 1, branchesCreated: 1, clonesCreated: 1, failed: 0 });
    expect(git(remote, "branch", "--list", "develop")).toBe("");
    expect(() => runGit(join(root, "develop", "Alpha"), ["status"])).toThrow();
  }, 30_000);

  it("creates the develop branch and clone, then updates the clean clone idempotently", async () => {
    const root = createWorkspace();
    const { remote, repository } = createRepository(root, "Bravo");

    const first = await ensureDevelopClones({ root, apply: true, write: () => {} });
    const clonePath = join(root, "develop", "Bravo");
    expect(first).toMatchObject({ branchesCreated: 1, clonesCreated: 1, failed: 0 });
    expect(git(clonePath, "branch", "--show-current")).toBe("develop");
    expect(git(remote, "branch", "--list", "develop")).toContain("develop");

    git(repository, "fetch", "origin");
    git(repository, "switch", "--detach", "origin/develop");
    writeFileSync(join(repository, "updated.txt"), "updated\n", "utf8");
    git(repository, "add", "updated.txt");
    git(repository, "commit", "-m", "update develop");
    git(repository, "push", "origin", "HEAD:develop");

    const second = await ensureDevelopClones({ root, apply: true, write: () => {} });
    expect(second).toMatchObject({ branchesCreated: 0, clonesCreated: 0, updated: 1, failed: 0 });
    expect(readFileSync(join(clonePath, "updated.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("updated\n");
    expect(git(clonePath, "rev-parse", "HEAD")).toBe(git(clonePath, "rev-parse", "origin/develop"));
  }, 30_000);

  it("preserves a dirty develop clone and skips its update", async () => {
    const root = createWorkspace();
    createRepository(root, "Charlie");
    await ensureDevelopClones({ root, apply: true, write: () => {} });
    const clonePath = join(root, "develop", "Charlie");
    writeFileSync(join(clonePath, "local.txt"), "do not delete\n", "utf8");
    const output = capture();

    const summary = await ensureDevelopClones({ root, apply: true, write: output.write });

    expect(summary).toMatchObject({ updated: 0, skipped: 1, failed: 0 });
    expect(output.lines[0]).toBe("[skip] Charlie: develop clone has uncommitted changes");
    expect(readFileSync(join(clonePath, "local.txt"), "utf8")).toBe("do not delete\n");
  }, 30_000);

  it("excludes named repositories, worktrees, and repositories without origin", async () => {
    const root = createWorkspace();
    const { repository } = createRepository(root, "Delta");
    const worktree = join(root, "Delta-worktree");
    git(repository, "worktree", "add", "--detach", worktree);
    const localOnly = join(root, "LocalOnly");
    mkdirSync(localOnly);
    git(localOnly, "init");
    git(localOnly, "symbolic-ref", "HEAD", "refs/heads/main");

    expect(findMainRepositories(root).map((path) => basename(path))).toEqual(["Delta", "LocalOnly"]);
    const output = capture();
    const summary = await ensureDevelopClones({
      root,
      excluded: new Set(["delta"]),
      write: output.write,
    });

    expect(summary).toMatchObject({ targets: 0, skipped: 2, failed: 0 });
    expect(output.lines).toContain("[skip] Delta: excluded");
    expect(output.lines).toContain("[skip] LocalOnly: origin remote not found");
    expect(output.lines.some((line) => line.includes("Delta-worktree"))).toBe(false);
  }, 30_000);
});
