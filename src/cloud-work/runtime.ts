import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import type { TaskStore } from "../taskflow/store.js";
import { CloudWorkRuntime, type CloudScope } from "./runtime-service.js";
import { CloudBatchKicker } from "./batch-kicker.js";
import { FileCloudBatchStore, type StoredCloudBatch } from "./batch-store.js";
import { observeCodexCloudTasks } from "./codex-observer.js";
import { readCloudTargets, type CloudTarget } from "./runtime-config.js";
import { createCodexCloudAdapter } from "./codex-adapter.js";
import { createClaudeCloudAdapter } from "./claude-adapter.js";
import { S3CloudArtifacts } from "./artifact-transfer.js";
import { join } from "node:path";
import { CloudGitReturn, type SubmitCloudLocalPr } from "./git-return.js";
import { cloudObservationInstructions, preflightObservation } from "../cloud-observation/instructions.js";

const exec = promisify(execFile);
type PreflightCommand = (executable: string, args: string[], cwd: string) => Promise<string>;
const preflightCommand: PreflightCommand = async (executable, args, cwd) => (await exec(executable, args, {
  cwd, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 65_536, encoding: "utf8",
  env: { ...process.env, CODEX_CLOUD_TASKS_BASE_URL: "https://chatgpt.com/backend-api" },
})).stdout;

/** Read-only checks happen before a durable submission intent or external launch. */
export async function preflightCloudTarget(target: CloudTarget, run: PreflightCommand = preflightCommand): Promise<void> {
  try {
    const result = await run("git", ["-c", `safe.directory=${target.repoPath}`, "ls-remote", "--exit-code", "origin", `refs/heads/${target.publishedBranch}`], target.repoPath);
    const [revision, ref] = result.trim().split(/\s+/);
    if (revision !== target.sourceRevision || ref !== `refs/heads/${target.publishedBranch}`) throw new Error("revision_mismatch");
  } catch { throw new Error("cloud_published_source_unverified"); }
  if (target.provider === "codex-cloud") {
    try {
      await run(target.codexExecutable!, ["cloud", "list", "--env", target.environmentId, "--json", "--limit", "1"], target.repoPath);
    } catch { throw new Error("codex_cloud_access_unverified"); }
  }
}

function cloudTaskAuthorizer(tasks: TaskStore) {
  return async (reference: string, scope: CloudScope, requireActive?: boolean): Promise<void> => {
    if (!tasks.read) throw new Error("cloud_task_store_unavailable");
    const task = await tasks.read(scope.repositoryKey, reference, scope.subsidiaryId);
    if (requireActive && ["done", "cancelled"].includes(task.runtime?.status ?? "")) throw new Error("cloud_task_not_active");
  };
}

/** Batch fan-out over the same runtime; only Codex Cloud has a supported read-only task listing. */
export function createCloudBatchKicker(input: { root: string; tasks: TaskStore; runtime: CloudWorkRuntime;
  authorizeKick(batch: StoredCloudBatch): Promise<void> }): CloudBatchKicker {
  return new CloudBatchKicker({
    store: new FileCloudBatchStore(join(input.root, "batches")),
    targets: scope => input.runtime.targets(scope),
    authorizeTask: cloudTaskAuthorizer(input.tasks),
    authorizeKick: input.authorizeKick,
    submit: (scope, request) => input.runtime.submit(scope, request),
    journal: (scope, attemptId) => input.runtime.attemptJournal(scope, attemptId),
    observe: (target, wanted) => observeCodexCloudTasks({ executable: target.codexExecutable!, cwd: target.repoPath,
      environmentId: target.environmentId, wanted }),
    now: () => Date.now(),
  });
}

/** Composition only; secrets are resolved through existing service env bindings. */
export function createCloudWorkRuntime(input: { root: string; tasks: TaskStore; env?: NodeJS.ProcessEnv; submitLocalPr?: SubmitCloudLocalPr }): CloudWorkRuntime {
  const env = input.env ?? process.env;
  const git = new CloudGitReturn(env.CONCORDIA_CLOUD_GIT_ROOT ?? join(input.root, "git-return"), env, mainRepositoryKey,
    input.submitLocalPr ?? (async () => { throw new Error("cloud_review_unavailable"); }));
  return new CloudWorkRuntime({
    root: input.root, env, now: () => Date.now(),
    targets: () => readCloudTargets(env.CONCORDIA_CLOUD_CONFIG_FILE), repositoryKey: mainRepositoryKey,
    authorizeTask: cloudTaskAuthorizer(input.tasks),
    preflight: async target => {
      if (env.CONCORDIA_CLOUD_OBSERVATION_ENABLED === "true" && target.subsidiaryId !== null)
        throw new Error("cloud_observation_head_office_only");
      await preflightObservation(env);
      if (target.transferMode === "git" && !input.submitLocalPr) throw new Error("cloud_review_unavailable");
      await preflightCloudTarget(target);
    },
    adapter: target => {
      const transferInstructions = target.transferMode === "git"
        ? (request: import("./submission.js").CloudSubmission) => git.instructions(target, request)
        : (request: { attemptId: string }) => new S3CloudArtifacts(target, env).uploadInstructions(request.attemptId);
      const transientInstructions = async (request: import("./submission.js").CloudSubmission): Promise<string> => {
        const transfer = await transferInstructions(request);
        const observation = await cloudObservationInstructions(env, target.id, request.attemptId, Date.now());
        return [transfer, observation].filter(Boolean).join("\n\n");
      };
      return target.provider === "codex-cloud"
        ? createCodexCloudAdapter({ executable: target.codexExecutable!, cwd: target.repoPath, publishedBranch: target.publishedBranch, transientInstructions })
        : createClaudeCloudAdapter({ triggerId: target.claudeTriggerId!, environmentId: target.environmentId,
          fireToken: env[target.claudeTokenEnv!] ?? "", transientInstructions });
    },
    collect: (target, attemptId) => new S3CloudArtifacts(target, env).collect(attemptId),
    collectGit: (target, attemptId) => git.collect(target, attemptId),
  });
}
