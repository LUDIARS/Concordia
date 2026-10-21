import { runAvailableOneShot, type OneShotAvailability, type OneShotTier } from "@ludiars/one-shot";
import { collectModelQuotaSnapshot } from "../delegation/model-tier-usage.js";
import type { ModelQuota } from "../delegation/model-tier-policy.js";
import { runClaude, type ClaudeRunResult } from "./claude-runner.js";
import { runTextCodex } from "./patrol-codex-runner.js";

/** @implements spec/feature/shared-available-one-shot.md CC-OS-02 */
export function oneShotAvailability(quota: ModelQuota, observedAt: { claude: number | null; codex: number | null }): OneShotAvailability {
  const windows = (values: ModelQuota["claude"]) => values.map(w => ({ usedPercent: w.used, resetsAt: w.reset }));
  return {
    claude: { observedAt: observedAt.claude ?? Number.NaN, windows: windows(quota.claude), modelWindows: {
      ...(quota.opus ? { opus: windows([quota.opus]) } : {}),
      ...(quota.sonnet ? { sonnet: windows([quota.sonnet]) } : {}),
    } },
    codex: { observedAt: observedAt.codex ?? Number.NaN, windows: windows(quota.codex) },
  };
}

/** Opt-in text only; deliberately does not accept tools, cwd or a pinned model.
 * @implements spec/feature/shared-available-one-shot.md CC-OS-01 CC-OS-03 CC-OS-04
 */
export async function runAvailableText(prompt: string, options: {
  tier?: OneShotTier; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<ClaudeRunResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_one_shot_timeout");
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  try {
    const { result } = await runAvailableOneShot<ClaudeRunResult>(prompt, {
      tier: options.tier ?? "high", signal,
      readAvailability: async () => {
        const snapshot = await collectModelQuotaSnapshot();
        return oneShotAvailability(snapshot.quota, snapshot.observedAt);
      },
      executors: {
        claude: (text, selected) => runClaude(text, {
          model: selected.model, conversationOnly: true, signal, timeoutMs,
        }),
        codex: async (text, selected) => {
          const result = await runTextCodex(text, {
            model: selected.model, signal, timeoutMs, purpose: "available-text",
          });
          return { ...result, exit_code: result.ok ? 0 : null, duration_ms: Date.now() - startedAt };
        },
      },
    });
    return result;
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : "one_shot_failed",
      exit_code: null, duration_ms: Date.now() - startedAt };
  }
}
