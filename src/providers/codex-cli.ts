import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, RecoveryInfo } from "./types.js";
import { codexSessionIdFromRecord } from "./codex-session-id.js";

export const codexCliProvider: AgentProvider = {
  name: "codex-cli",

  resolveSessionId(env) {
    return env.CODEX_SESSION_ID ?? env.CONCORDIA_SESSION_ID ?? null;
  },

  transcriptPath(sessionId) {
    if (!sessionId) return null;
    return findCodexTranscript(sessionId);
  },

  parseTranscript(content): RecoveryInfo {
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const out: RecoveryInfo = {
      jsonl_lines: lines.length,
      last_message_role: "system",
    };

    for (let i = lines.length - 1; i >= 0; i--) {
      let obj: any;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      if (!out.last_text_summary) {
        const text = extractText(obj);
        if (text) {
          out.last_text_summary = text.slice(0, 200);
          out.last_message_role = inferRole(obj);
        }
      }

      if (!out.last_tool_use) {
        const tool = extractToolUse(obj, i);
        if (tool) out.last_tool_use = tool;
      }

      if (!out.todos) {
        const todos = extractTodos(obj);
        if (todos) out.todos = todos;
      }

      if (out.last_text_summary && out.last_tool_use && out.todos) break;
    }

    return out;
  },
};

export function findCodexTranscript(sessionId: string): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;

  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 10000) {
    const dir = stack.pop()!;
    visited++;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      if (transcriptHasSessionId(p, sessionId)) return p;
    }
  }
  return null;
}

function transcriptHasSessionId(path: string, sessionId: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/).slice(0, 20)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const id = codexSessionIdFromRecord(obj);
      if (id === sessionId) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function inferRole(obj: any): RecoveryInfo["last_message_role"] {
  const role = obj?.payload?.role ?? obj?.role ?? obj?.payload?.message?.role;
  if (role === "user" || role === "assistant" || role === "tool_result") return role;
  return "assistant";
}

function extractText(obj: any): string | null {
  const payload = obj?.payload ?? obj;
  const candidates = [
    payload?.message,
    payload?.content,
    payload?.text,
    payload?.delta,
    payload,
  ];
  for (const candidate of candidates) {
    const text = extractContentText(candidate);
    if (text) return text;
  }
  return null;
}

function extractContentText(value: any): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(extractContentText).filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof value !== "object") return null;
  if (value.role && value.role !== "assistant") return null;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extractContentText(value.content);
  if (typeof value.text === "string") return value.text;
  return null;
}

function extractToolUse(obj: any, fallbackTs: number): RecoveryInfo["last_tool_use"] | null {
  const payload = obj?.payload ?? obj;
  const type = payload?.type ?? obj?.type;
  const name = payload?.name ?? payload?.tool_name ?? payload?.call?.name;
  if (
    type === "function_call" ||
    type === "tool_call" ||
    type === "local_shell_call" ||
    typeof name === "string"
  ) {
    return {
      tool: String(name ?? type ?? "unknown"),
      input: payload?.arguments ?? payload?.input ?? payload?.call?.arguments ?? {},
      ts: typeof obj?.timestamp === "number" ? obj.timestamp : fallbackTs,
    };
  }
  return null;
}

function extractTodos(obj: any): RecoveryInfo["todos"] {
  const payload = obj?.payload ?? obj;
  const raw =
    payload?.todos ??
    payload?.input?.todos ??
    payload?.arguments?.todos ??
    payload?.plan;
  if (!Array.isArray(raw)) return undefined;
  const todos = raw
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      const subject =
        typeof item.step === "string"
          ? item.step
          : typeof item.content === "string"
            ? item.content
            : typeof item.subject === "string"
              ? item.subject
              : null;
      if (!subject) return null;
      return { subject, status: typeof item.status === "string" ? item.status : "pending" };
    })
    .filter(Boolean) as NonNullable<RecoveryInfo["todos"]>;
  return todos.length ? todos : undefined;
}
