import { cloudProviderPrompt } from "./provider-prompt.js";
import type { CloudReceipt, CloudSubmission, CloudSubmitter } from "./submission.js";
import { createCloudCliExecute, nativeExecutable, type CloudCliExecute } from "./cloud-cli-process.js";

const execute: CloudCliExecute = createCloudCliExecute({ failureCode: "codex_cloud_process_failed",
  env: { ...process.env, CODEX_CLOUD_TASKS_BASE_URL: "https://chatgpt.com/backend-api" } });

/** A concrete native CLI binary is required on Windows; never launch a .cmd via a shell. */
export function createCodexCloudAdapter(config: {
  executable: string; cwd: string; publishedBranch: string; transientInstructions?: (request: CloudSubmission) => string | Promise<string>;
}, run: CloudCliExecute = execute): CloudSubmitter {
  if (!nativeExecutable(config.executable) || !config.cwd || !config.publishedBranch || config.publishedBranch.startsWith("-")) {
    throw new Error("invalid_codex_cloud_configuration");
  }
  return {
    provider: "codex-cloud",
    async submit(request: CloudSubmission): Promise<CloudReceipt> {
      const output = await run(config.executable, ["cloud", "exec", "--env", request.environmentId,
        "--branch", config.publishedBranch, "--attempts", "1", "-"], config.cwd,
        [cloudProviderPrompt(request), await config.transientInstructions?.(request) ?? ""].join("\n"));
      // Official CLI run_exec_command prints the created task URL. Do not infer
      // submission from exit zero alone or retain arbitrary provider output.
      const match = /^https:\/\/chatgpt\.com\/codex\/tasks\/(task_[a-zA-Z0-9_-]+)\s*$/.exec(output.trim());
      return match ? { state: "submitted", remoteId: match[1] } : { state: "submission_unknown" };
    },
  };
}
