/**
 * Provider registry. provider name → AgentProvider 実装.
 */

import type { ProviderName } from "../shared/types.js";
import type { AgentProvider } from "./types.js";
import { claudeCodeProvider } from "./claude-code.js";
import { geminiCliProvider } from "./gemini-cli.js";
import { codexCliProvider } from "./codex-cli.js";

const PROVIDERS: Record<ProviderName, AgentProvider | null> = {
  "claude-code": claudeCodeProvider,
  "gemini-cli": geminiCliProvider,
  "codex-cli": codexCliProvider,
  // local-llm (Lictor ネイティブ local-agent) は専用の AgentProvider 実装を持たない
  // (recovery 等の CLI 固有処理が無いため)。 unknown と同様 null で degrade する。
  "local-llm": null,
  unknown: null,
};

export function getProvider(name: ProviderName | string): AgentProvider | null {
  return PROVIDERS[name as ProviderName] ?? null;
}

export type { AgentProvider, RecoveryInfo } from "./types.js";
