import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
let selectOwnedWorktree: typeof import("./switch-worktree.js")["selectOwnedWorktree"];
let resolveWorktreeContext: typeof import("./worktree-context.js")["resolveWorktreeContext"];
let inspectImplementationRepo: typeof import("./repo-context.js")["inspectImplementationRepo"];
let mainRepositoryKey: typeof import("../taskflow/repository-identity.js")["mainRepositoryKey"];
import { repositoryKey } from "../taskflow/actio-binding.js";
vi.mock("./worktree-context.js", () => ({ resolveWorktreeContext: vi.fn() }));
vi.mock("./repo-context.js", () => ({ inspectImplementationRepo: vi.fn() }));
vi.mock("../taskflow/repository-identity.js", () => ({ mainRepositoryKey: vi.fn() }));
// isolate:false shares modules with earlier files that import the real implementation.
// Reload dependencies and the subject together so this file's mocks bind consistently.
beforeEach(async () => {
  vi.resetModules();
  ({ resolveWorktreeContext } = await import("./worktree-context.js"));
  ({ inspectImplementationRepo } = await import("./repo-context.js"));
  ({ mainRepositoryKey } = await import("../taskflow/repository-identity.js"));
  ({ selectOwnedWorktree } = await import("./switch-worktree.js"));
});
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(owner = "own", actualBranch = "feat/tools") {
  const dir = await mkdtemp(join(tmpdir(), "cc-switch-tools-")); dirs.push(dir);
  const main = join(dir, "main"); const worktree = join(dir, "worktree");
  await mkdir(join(worktree, ".local", "concordia"), { recursive: true });
  await writeFile(join(worktree, ".local", "concordia", "worktree.json"), JSON.stringify({
    version: 1, owner: createHash("sha256").update(owner).digest("hex"), projectCode: "Cc", actioProjectId: "Cc",
    mainRepo: main, worktree, branch: "feat/tools", baseCommit: "a".repeat(40),
  }));
  vi.mocked(resolveWorktreeContext).mockResolvedValue({ project: { code: "Cc" } as never, branch: "feat/tools", mainRepo: main, worktree });
  vi.mocked(inspectImplementationRepo).mockResolvedValue({ repoPath: worktree, repoOrigin: null, branch: actualBranch });
  vi.mocked(mainRepositoryKey).mockResolvedValue(repositoryKey(main));
  return worktree;
}
describe("owned checkout selection", () => {
  const input = { sessionId: "own", projectCode: "Cc", branch: "feat/tools", task: "tools" };
  it("selects its own branch without changing Git or files", async () => {
    const worktree = await fixture();
    expect(await selectOwnedWorktree(input, [], [])).toBe(worktree);
  });
  it("refuses another session's worktree", async () => {
    await fixture("other");
    await expect(selectOwnedWorktree(input, [], [])).rejects.toThrow("worktree ownership mismatch");
  });
  it("refuses a checkout whose actual branch changed", async () => {
    await fixture("own", "main");
    await expect(selectOwnedWorktree(input, [], [])).rejects.toThrow("worktree ownership mismatch");
  });
});
