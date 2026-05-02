/**
 * Codex CLI (OpenAI) provider — v0.1 stub.
 * 詳細は spec/multi-provider.md §4 参照. v0.2 で詰める.
 */

import type { AgentProvider, RecoveryInfo } from "./types.js";

export const codexCliProvider: AgentProvider = {
  name: "codex-cli",

  resolveSessionId(env) {
    return env.CODEX_SESSION_ID ?? env.CONCORDIA_SESSION_ID ?? null;
  },

  transcriptPath() {
    return null;
  },

  parseTranscript(): RecoveryInfo {
    return {
      jsonl_lines: 0,
      last_message_role: "system",
    };
  },
};
