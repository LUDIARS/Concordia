import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { prepareSpawnTarget } from "../control/spawn-target.js";
import { copyWorktreeProjectConfig } from "../control/worktree-project-config.js";
import { copyWorktreeProjectMemory } from "../control/worktree-project-memory.js";
import { inspectImplementationRepo, isWithinWorkspace } from "./repo-context.js";
import { keepWorktreeRecord, WorktreeRecord, type WorktreeGit } from "./worktree-metadata.js";
import { worktreeGit } from "./worktree-git.js";
import { resolveWorktreeContext, type WorktreeContext } from "./worktree-context.js";

export interface CreateWorktreeInput { sessionId: string; projectCode: string; branch: string; task: string }
export interface WorktreePreparationDeps {
  projects: readonly ProjectCodeRow[];
  workspaceRoots: readonly string[];
  subsidiaryId: string | null;
  resolveActio: (repo: string, subsidiaryId: string | null) => Promise<ActioBinding>;
  bind: (input: { sessionId: string; cwd: string; task: string }) => Promise<unknown>;
  git?: WorktreeGit;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

async function reserveWorktree(
  context: WorktreeContext, sessionId: string, actioProjectId: string, git: WorktreeGit,
): Promise<WorktreeRecord> {
  const { project, branch, mainRepo, worktree } = context;
  const reservation = `allocation-${hash(branch)}.json`;
  const reservationPath = join(mainRepo, ".local", "concordia", reservation);
  const reservationStat = await lstat(reservationPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  // A branch is reusable only when this tool previously reserved it for this session.
  const existingBranch = (await git(mainRepo, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]))
    .split(/\r?\n/).includes(`refs/heads/${branch}`);
  if (existingBranch && !reservationStat) throw new Error("existing branch is not owned by this worktree request");
  if (reservationStat?.isSymbolicLink()) throw new Error("invalid worktree reservation");
  const requested: WorktreeRecord = {
    version: 1, owner: hash(sessionId), projectCode: project.code, actioProjectId,
    mainRepo, worktree, branch,
    baseCommit: (await git(mainRepo, ["rev-parse", "--verify", "refs/heads/main^{commit}"])).trim(),
  };
  // Reserve before Git allocation so interruption after worktree add remains recoverable.
  return keepWorktreeRecord(mainRepo, reservation, requested, git);
}

async function placeWorktreeResources(record: WorktreeRecord, target: string, roots: readonly string[], git: WorktreeGit) {
  if (!await isWithinWorkspace(target, roots)
    || repositoryKey(await realpath(target)) !== repositoryKey(record.worktree)
    || await mainRepositoryKey(target) !== repositoryKey(record.mainRepo)) throw new Error("worktree Git identity mismatch");
  const actual = await inspectImplementationRepo(target);
  if (actual.branch !== record.branch) throw new Error("worktree branch mismatch");
  await keepWorktreeRecord(target, "worktree.json", record, git);
  await copyWorktreeProjectConfig(record.mainRepo, target);
  await copyWorktreeProjectMemory(record.mainRepo, target);
}

/** Prepare the owned checkout before changing session state. Git/Actio remain authoritative. */
export async function createImplementationWorktree(input: CreateWorktreeInput, deps: WorktreePreparationDeps) {
  const context = await resolveWorktreeContext(input, deps.projects, deps.workspaceRoots);
  const actio = await deps.resolveActio(context.mainRepo, deps.subsidiaryId);
  const git = deps.git ?? worktreeGit;
  const record = await reserveWorktree(context, input.sessionId, actio.projectId, git);
  const result = await prepareSpawnTarget({
    cwd: record.mainRepo, branch: record.branch, worktree: true, worktreeBaseDir: dirname(record.mainRepo),
    baseRef: record.baseCommit, retainOnResourceFailure: true, git,
    projectResources: (_source, target) => placeWorktreeResources(record, target, deps.workspaceRoots, git),
  });
  if (!result.ok || !result.cwd) throw new Error("worktree preparation incomplete; retry the same project and branch");
  // Git porcelain may use different slash/case spelling on retry; return the reserved path.
  await deps.bind({ sessionId: input.sessionId, cwd: record.worktree, task: input.task });
  return { ok: true as const, project_code: record.projectCode, actio_project_id: actio.projectId,
    branch: record.branch, cwd: record.worktree, created: result.worktree_created,
    metadata_path: join(record.worktree, ".local", "concordia", "worktree.json") };
}
