/**
 * AgentProvider 抽象. spec/multi-provider.md §1 準拠.
 */

import type { ProviderName } from "../shared/types.js";

export interface RecoveryInfo {
  jsonl_lines: number;
  last_message_role: "user" | "assistant" | "tool_result" | "system";
  last_tool_use?: { tool: string; input: unknown; ts: number };
  last_text_summary?: string;
  todos?: Array<{ status: string; subject: string }>;
}

export interface AgentProvider {
  readonly name: ProviderName;
  resolveSessionId(env: Record<string, string>): string | null;
  transcriptPath(sessionId: string, cwd: string): string | null;
  parseTranscript(content: string): RecoveryInfo;
  generateHookConfig?(): unknown;
}
