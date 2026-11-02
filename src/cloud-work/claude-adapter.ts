import { cloudProviderPrompt } from "./provider-prompt.js";
import type { CloudReceipt, CloudSubmission, CloudSubmitter } from "./submission.js";
import { createCloudCliExecute, nativeExecutable, type CloudCliExecute } from "./cloud-cli-process.js";

/** API keys and third-party providers take precedence over the claude.ai login that cloud sessions require. */
const OVERRIDING_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
export function claudeCloudEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !OVERRIDING_AUTH.includes(key)));
}

const execute: CloudCliExecute = createCloudCliExecute({ failureCode: "claude_cloud_process_failed", env: claudeCloudEnv(process.env) });
export const CLAUDE_SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]{6,200}$/;

/** Exactly one distinct session ID must appear; anything else is unknown, never guessed. */
function createdSessionId(output: string): string | null {
  const ids = new Set(output.match(/\b(?:session|cse)_[A-Za-z0-9_-]{6,200}\b/g) ?? []);
  const [id] = [...ids];
  return ids.size === 1 && CLAUDE_SESSION_ID.test(id) ? id : null;
}

/**
 * @implements CC-CLOUD-CLAUDE-CLI
 * Launches through the official `claude --cloud` CLI as Codex does. The work packet is public task data and
 * goes in argv to create the session; private transfer capabilities follow as one queued message on stdin,
 * so no secret ever reaches the process list.
 */
export function createClaudeCloudAdapter(config: {
  executable: string; cwd: string;
  transientInstructions?: (request: CloudSubmission) => string | Promise<string>;
}, run: CloudCliExecute = execute): CloudSubmitter {
  if (!nativeExecutable(config.executable) || !config.cwd) throw new Error("invalid_claude_cloud_configuration");
  return {
    provider: "claude-cloud",
    async submit(request: CloudSubmission): Promise<CloudReceipt> {
      // Prepare capabilities first: a preparation failure must not leave a session that cannot return work.
      const transfer = await config.transientInstructions?.(request) ?? "";
      const packet = [cloudProviderPrompt(request), transfer
        ? "Private transfer instructions arrive in the next message. Do the work, but do not upload or push until it arrives."
        : ""].filter(Boolean).join("\n");
      const id = createdSessionId(await run(config.executable, ["--cloud", packet], config.cwd, ""));
      if (!id) return { state: "submission_unknown" };
      if (!transfer) return { state: "submitted", remoteId: id };
      let reply: unknown;
      try {
        reply = JSON.parse(await run(config.executable, ["-p", "--cloud", id, "--output-format", "json"], config.cwd, transfer));
      } catch { return { state: "submission_unknown" }; }
      const sent = reply as { ok?: unknown; session_id?: unknown } | null;
      // A session without its transfer message cannot return results: report unknown so the operator reconciles it.
      return sent?.ok === true && sent.session_id === id ? { state: "submitted", remoteId: id } : { state: "submission_unknown" };
    },
  };
}
