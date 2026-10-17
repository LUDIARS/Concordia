import { spawn } from "node:child_process";
import { cloudProviderPrompt } from "./provider-prompt.js";
import type { CloudReceipt, CloudSubmission, CloudSubmitter } from "./submission.js";

type Execute = (executable: string, args: string[], cwd: string, stdin: string) => Promise<string>;

const execute: Execute = (executable, args, cwd, stdin) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_CLOUD_TASKS_BASE_URL: "https://chatgpt.com/backend-api" } });
  const chunks: Buffer[] = [];
  let total = 0, failed = false;
  const fail = (): void => { failed = true; child.kill(); };
  const timer = setTimeout(fail, 60_000);
  child.stdout.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 65_536) fail(); else chunks.push(chunk); });
  // Drain without retaining errors: CLI diagnostics can echo sensitive request material.
  child.stderr.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 65_536) fail(); });
  child.stdin.on("error", fail);
  child.on("error", () => { clearTimeout(timer); reject(new Error("codex_cloud_process_failed")); });
  child.on("close", code => {
    clearTimeout(timer);
    if (failed || code !== 0) reject(new Error("codex_cloud_process_failed"));
    else resolve(Buffer.concat(chunks).toString("utf8"));
  });
  child.stdin.end(stdin, "utf8");
});

/** A concrete native CLI binary is required on Windows; never launch a .cmd via a shell. */
export function createCodexCloudAdapter(config: {
  executable: string; cwd: string; publishedBranch: string; transientInstructions?: (request: CloudSubmission) => string | Promise<string>;
}, run: Execute = execute): CloudSubmitter {
  if (!config.executable || /\.(cmd|bat|ps1)$/i.test(config.executable)
    || !config.cwd || !config.publishedBranch || config.publishedBranch.startsWith("-")) {
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
