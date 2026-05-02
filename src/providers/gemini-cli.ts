/**
 * Gemini CLI provider — v0.1 stub.
 * 詳細は spec/multi-provider.md §3 参照. v0.2 で詰める.
 */

import type { AgentProvider, RecoveryInfo } from "./types.js";

export const geminiCliProvider: AgentProvider = {
  name: "gemini-cli",

  resolveSessionId(env) {
    return env.GEMINI_SESSION_ID ?? env.CONCORDIA_SESSION_ID ?? null;
  },

  transcriptPath() {
    return null; // v0.2 で実装
  },

  parseTranscript(): RecoveryInfo {
    return {
      jsonl_lines: 0,
      last_message_role: "system",
    };
  },
};
