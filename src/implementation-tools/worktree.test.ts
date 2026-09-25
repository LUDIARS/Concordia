import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImplementationWorktree, type WorktreePreparationDeps } from "./worktree.js";
import { worktreeGit } from "./worktree-git.js";
import { branchWorktreeName } from "../control/spawn-target.js";
import { copyWorktreeProjectConfig } from "../control/worktree-project-config.js";
import { LOCAL_ACTIO_ACCESS } from "../taskflow/actio-projects.js";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";

vi.mock("../control/worktree-project-config.js", () => ({ copyWorktreeProjectConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../control/worktree-project-memory.js", () => ({ copyWorktreeProjectMemory: vi.fn().mockResolvedValue(undefined) }));

describe("Cc worktree creation and recovery", () => {
  let root: string, main: string, target: string, deps: WorktreePreparationDeps;
  const input = { sessionId: "owner-session", projectCode: "El", branch: "feat/work", task: "dictionary" };
  const commit = async () => worktreeGit(main, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "fixture"]);
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(copyWorktreeProjectConfig).mockResolvedValue(undefined as never);
    root = await mkdtemp(join(tmpdir(), "cc-worktree-usecase-"));
    main = join(root, "Checkout");
    await mkdir(main);
    await worktreeGit(main, ["init", "-b", "main"]);
    await commit();
    target = join(root, branchWorktreeName(main, input.branch));
    deps = {
      projects: [{ code: "El", project: "Elegantia", repo_path: main, repo_origin: null } as ProjectCodeRow],
      workspaceRoots: [root], subsidiaryId: null,
      resolveActio: vi.fn().mockResolvedValue({ ...LOCAL_ACTIO_ACCESS, project: "Elegantia", projectId: "El", repoPath: main }),
      bind: vi.fn().mockResolvedValue({ ok: true }),
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("uses local main, ignores remote branch tips, and reuses the original worktree after main advances", async () => {
    const base = (await worktreeGit(main, ["rev-parse", "main"])).trim();
    await worktreeGit(main, ["branch", "main-snapshot"]);
    await commit();
    const remote = (await worktreeGit(main, ["rev-parse", "main"])).trim();
    await worktreeGit(main, ["update-ref", "refs/remotes/origin/feat/work", remote]);
    await worktreeGit(main, ["reset", "--soft", base]);
    const first = await createImplementationWorktree(input, deps);
    expect(first).toMatchObject({ ok: true, created: true, cwd: target, actio_project_id: "El" });
    expect((await worktreeGit(target, ["rev-parse", "HEAD"])).trim()).toBe(base);
    expect((await worktreeGit(main, ["branch", "--show-current"])).trim()).toBe("main");
    await commit();
    const again = await createImplementationWorktree(input, deps);
    expect(again).toMatchObject({ created: false, cwd: target });
    expect(JSON.parse(await readFile(first.metadata_path, "utf8")).baseCommit).toBe(base);
    expect(await worktreeGit(target, ["status", "--porcelain"])).toBe("");
    expect(deps.bind).toHaveBeenCalledWith({ sessionId: input.sessionId, cwd: target, task: input.task });
  });

  it("retains the worktree and retries binding after a failed session update", async () => {
    vi.mocked(deps.bind).mockRejectedValueOnce(new Error("binding interrupted"));
    await expect(createImplementationWorktree(input, deps)).rejects.toThrow("binding interrupted");
    await writeFile(join(target, "user-work.txt"), "keep");
    expect((await createImplementationWorktree(input, deps)).created).toBe(false);
    expect(await readFile(join(target, "user-work.txt"), "utf8")).toBe("keep");
  });

  it("retains the branch on resource-copy failure and resumes on the same request", async () => {
    vi.mocked(copyWorktreeProjectConfig).mockRejectedValueOnce(new Error("copy interrupted"));
    await expect(createImplementationWorktree(input, deps)).rejects.toThrow("preparation incomplete");
    expect((await lstat(target)).isDirectory()).toBe(true);
    expect(deps.bind).not.toHaveBeenCalled();
    expect((await createImplementationWorktree(input, deps)).created).toBe(false);
  });

  it("refuses another session's reservation and preserves its files", async () => {
    await createImplementationWorktree(input, deps);
    await writeFile(join(target, "user-work.txt"), "keep");
    await expect(createImplementationWorktree({ ...input, sessionId: "other" }, deps)).rejects.toThrow("different request");
    expect(await readFile(join(target, "user-work.txt"), "utf8")).toBe("keep");
    expect(deps.bind).toHaveBeenCalledTimes(1);
  });

  it("rejects an existing unowned branch and protected branches", async () => {
    await worktreeGit(main, ["branch", input.branch]);
    await expect(createImplementationWorktree(input, deps)).rejects.toThrow("not owned");
    await expect(createImplementationWorktree({ ...input, branch: "main" }, deps)).rejects.toThrow("task branch");
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("fails before allocation when Actio cannot establish the project", async () => {
    vi.mocked(deps.resolveActio).mockRejectedValue(new Error("Actio unavailable"));
    await expect(createImplementationWorktree(input, deps)).rejects.toThrow("Actio unavailable");
    await expect(lstat(join(main, ".local"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("rejects unregistered projects, mismatched origins, and repositories outside the workspace", async () => {
    await expect(createImplementationWorktree({ ...input, projectCode: "el" }, deps)).rejects.toThrow("missing or ambiguous");
    const wrongOrigin = { ...deps, projects: [{ ...deps.projects[0]!, repo_origin: "LUDIARS/Other" }] };
    await expect(createImplementationWorktree(input, wrongOrigin)).rejects.toThrow("origin mismatch");
    await expect(createImplementationWorktree(input, { ...deps, workspaceRoots: [target] }))
      .rejects.toThrow("invalid main");
    expect(deps.resolveActio).not.toHaveBeenCalled();
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("refuses an identically named checkout from a different Git repository", async () => {
    await mkdir(target);
    await worktreeGit(target, ["init", "-b", input.branch]);
    await writeFile(join(target, "keep.txt"), "keep");
    await expect(createImplementationWorktree(input, deps)).rejects.toThrow("preparation incomplete");
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("keep");
    expect(deps.bind).not.toHaveBeenCalled();
  });
});
