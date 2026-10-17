import { cloudProviderPrompt } from "./provider-prompt.js";
import type { CloudReceipt, CloudSubmission, CloudSubmitter } from "./submission.js";

/** Only the routine fire API is used; a Platform inference key is not interchangeable. */
export function createClaudeCloudAdapter(config: {
  triggerId: string;
  environmentId: string;
  /** Resolved by the existing secret binding; never persisted with the request. */
  fireToken: string;
  transientInstructions?: (request: CloudSubmission) => string | Promise<string>;
}, fetcher: typeof fetch = fetch): CloudSubmitter {
  if (!/^trig_[a-zA-Z0-9]+$/.test(config.triggerId) || !config.fireToken.trim() || !config.environmentId.trim()) {
    throw new Error("invalid_claude_cloud_configuration");
  }
  return {
    provider: "claude-cloud",
    async submit(request: CloudSubmission): Promise<CloudReceipt> {
      if (request.environmentId !== config.environmentId) throw new Error("cloud_environment_mismatch");
      const response = await fetcher(`https://api.anthropic.com/v1/claude_code/routines/${config.triggerId}/fire`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${config.fireToken}`, "content-type": "application/json",
          "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ text: [cloudProviderPrompt(request), await config.transientInstructions?.(request) ?? ""].join("\n") }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { state: "submission_unknown" };
      }
      const reader = response.body?.getReader();
      if (!reader) return { state: "submission_unknown" };
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 16_384) {
            await reader.cancel();
            return { state: "submission_unknown" };
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object") return { state: "submission_unknown" };
      const receipt = value as Record<string, unknown>;
      return receipt.type === "routine_fire" && typeof receipt.claude_code_session_id === "string"
        && /^session_[a-zA-Z0-9_-]+$/.test(receipt.claude_code_session_id)
        ? { state: "submitted", remoteId: receipt.claude_code_session_id }
        : { state: "submission_unknown" };
    },
  };
}
