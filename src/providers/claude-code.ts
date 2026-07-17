/**
 * Claude Code provider. spec/multi-provider.md §2 準拠.
 *
 * - session_id: env CLAUDE_SESSION_ID or hook 引数で渡される (wrapper 側で解決)
 * - transcript: ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl
 * - format: 1 行 1 JSON object
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, RecoveryInfo } from "./types.js";

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",

  resolveSessionId(env) {
    return env.CLAUDE_SESSION_ID ?? env.CONCORDIA_SESSION_ID ?? null;
  },

  async transcriptPath(sessionId, cwd) {
    if (!sessionId || !cwd) return null;
    const encoded = encodeCwdForClaude(cwd);
    return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
  },

  async parseTranscript(content) {
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const out: RecoveryInfo = {
      jsonl_lines: lines.length,
      last_message_role: "system",
    };
    let lastTodos: RecoveryInfo["todos"];

    for (let i = lines.length - 1; i >= 0; i--) {
      let obj: any;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const role = obj.role ?? obj.type;
      if (!out.last_text_summary && role === "assistant") {
        const text = extractText(obj);
        if (text) {
          out.last_text_summary = text.slice(0, 200);
          out.last_message_role = "assistant";
        }
      }
      if (!out.last_tool_use && obj.type === "tool_use") {
        out.last_tool_use = {
          tool: obj.name ?? "unknown",
          input: obj.input ?? {},
          ts: typeof obj.ts === "number" ? obj.ts : i,
        };
      }
      if (!lastTodos && isTodoWriteToolUse(obj)) {
        lastTodos = extractTodos(obj.input?.todos ?? obj.todos);
      }
      if (out.last_text_summary && out.last_tool_use && lastTodos) break;
    }

    if (lastTodos) out.todos = lastTodos;
    return out;
  },
};

/**
 * Claude Code が cwd → projects ディレクトリ名へ変換するルールに合わせる.
 * 観測: `/` `\` `:` `.` を `-` に置換.
 */
export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[\\/:.]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractText(msg: any): string | null {
  if (!msg) return null;
  const content = msg.content ?? msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return null;
}

function isTodoWriteToolUse(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (obj.type === "tool_use" && typeof obj.name === "string") {
    return obj.name === "TodoWrite" || obj.name === "TaskCreate" || obj.name === "TaskUpdate";
  }
  return false;
}

function extractTodos(raw: unknown): RecoveryInfo["todos"] {
  if (!Array.isArray(raw)) return undefined;
  const out: NonNullable<RecoveryInfo["todos"]> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const subject =
      typeof o.content === "string"
        ? o.content
        : typeof o.subject === "string"
          ? o.subject
          : null;
    const status = typeof o.status === "string" ? o.status : "pending";
    if (subject) out.push({ subject, status });
  }
  return out.length > 0 ? out : undefined;
}
