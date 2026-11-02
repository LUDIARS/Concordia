import { cloudProviderPrompt } from "./provider-prompt.js";
import { readCloudResponse } from "./artifact-transfer.js";
import type { CloudReceipt, CloudSubmission, CloudSubmitter } from "./submission.js";
import { createCloudCliExecute, nativeExecutable, type CloudCliExecute } from "./cloud-cli-process.js";

/** API keys and third-party providers take precedence over the claude.ai login that cloud follow-ups require. */
const OVERRIDING_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
export function claudeCloudEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !OVERRIDING_AUTH.includes(key)));
}

const execute: CloudCliExecute = createCloudCliExecute({ failureCode: "claude_cloud_process_failed", env: claudeCloudEnv(process.env) });
export const CLAUDE_SESSION_ID = /^(?:session|cse)_[A-Za-z0-9_-]{1,200}$/;

/** Routine fire: the only documented non-interactive way to create a hosted session (`claude --cloud` needs a TTY). */
async function fireRoutine(triggerId: string, token: string, text: string, fetcher: typeof fetch): Promise<string | null> {
  const response = await fetcher(`https://api.anthropic.com/v1/claude_code/routines/${triggerId}/fire`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ text }),
  });
  const receipt = JSON.parse((await readCloudResponse(response, 16_384)).toString("utf8")) as Record<string, unknown> | null;
  const id = receipt?.type === "routine_fire" ? receipt.claude_code_session_id : null;
  return typeof id === "string" && CLAUDE_SESSION_ID.test(id) ? id : null;
}

/**
 * @implements CC-CLOUD-CLAUDE-HYBRID
 * Creates the session by routine fire with public task data only, then queues the private transfer
 * capabilities as one ordinary user message through `claude -p --cloud <id>` on stdin. Secrets never enter
 * the routine payload (an untrusted-data block) or the process list.
 */
export function createClaudeCloudAdapter(config: {
  triggerId: string; fireToken: string; executable: string; cwd: string;
  transientInstructions?: (request: CloudSubmission) => string | Promise<string>;
}, deps: { fetcher?: typeof fetch; run?: CloudCliExecute } = {}): CloudSubmitter {
  if (!/^trig_[a-zA-Z0-9]+$/.test(config.triggerId) || !config.fireToken.trim()
    || !nativeExecutable(config.executable) || !config.cwd) throw new Error("invalid_claude_cloud_configuration");
  const fetcher = deps.fetcher ?? fetch, run = deps.run ?? execute;
  return {
    provider: "claude-cloud",
    async submit(request: CloudSubmission): Promise<CloudReceipt> {
      // Prepare capabilities first: a preparation failure must not leave a session that cannot return work.
      const transfer = await config.transientInstructions?.(request) ?? "";
      const packet = [cloudProviderPrompt(request), transfer
        ? "Private transfer instructions arrive in the next user message. Do the work, but do not upload or push until it arrives."
        : ""].filter(Boolean).join("\n");
      let id: string | null;
      try { id = await fireRoutine(config.triggerId, config.fireToken, packet, fetcher); }
      catch { return { state: "submission_unknown" }; }
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
