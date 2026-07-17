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
  /**
   * transcript のパス解決。 codex はツリー走査 I/O を伴うため Promise 契約
   * (完全非同期 — 同期 fs でイベントループを止めない)。
   */
  transcriptPath(sessionId: string, cwd: string): Promise<string | null>;
  /** transcript 本文の解析。 実装が I/O を挟めるよう Promise 契約に統一。 */
  parseTranscript(content: string): Promise<RecoveryInfo>;
  generateHookConfig?(): unknown;
}
