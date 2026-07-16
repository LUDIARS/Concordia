import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, RecoveryInfo } from "./types.js";
import { codexSessionIdFromRecord } from "./codex-session-id.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("providers:codex-cli");

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

/**
 * transcript 判定で読む先頭バイト数。 codex rollout の session id record は
 * 1 行目に来るため先頭チャンクで十分 (全量 readFileSync は 1.5GB 級ツリーで
 * イベントループを数十秒塞いだ実績があるため禁止 — 2026-07-16 障害)。
 */
const HEAD_READ_BYTES = 64 * 1024;
/** 判定に使う先頭行数 (旧実装と同じ)。 */
const HEAD_LINES = 20;
/** 見つからなかった sessionId の再スキャン抑止 TTL (ms)。 */
export const MISS_CACHE_TTL_MS = 60_000;
/** 1 スキャンで辿るディレクトリ数の上限 (暴走防止, 旧実装と同値)。 */
const MAX_DIRS_PER_SCAN = 10_000;
/** これ以上かかったスキャンは warn を出す (ms)。 */
const SLOW_SCAN_WARN_MS = 500;

/** sessionId → 発見済み transcript path。 rollout の path は不変なので永続キャッシュ。 */
const foundPathCache = new Map<string, string>();
/** sessionId → 次に再スキャンしてよい epoch-ms (負キャッシュ)。 */
const missCache = new Map<string, number>();

/** テスト用: キャッシュを全クリアする。 */
export function resetCodexTranscriptCache(): void {
  foundPathCache.clear();
  missCache.clear();
}

export interface FindCodexTranscriptOptions {
  /** sessions ルート (テスト用)。 既定 `~/.codex/sessions`。 */
  root?: string;
  /** epoch-ms クロック (テスト用)。 既定 Date.now。 */
  now?: () => number;
}

export function findCodexTranscript(
  sessionId: string,
  opts: FindCodexTranscriptOptions = {},
): string | null {
  const now = opts.now ?? Date.now;
  const cached = foundPathCache.get(sessionId);
  if (cached) {
    if (existsSync(cached)) return cached;
    foundPathCache.delete(sessionId);
  }
  const retryAfter = missCache.get(sessionId);
  if (retryAfter !== undefined && now() < retryAfter) return null;

  const root = opts.root ?? join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;

  const startedAt = now();
  let visited = 0;
  let filesChecked = 0;
  const stack = [root];
  let found: string | null = null;
  // 深さ優先 + 名前降順 (YYYY/MM/DD / rollout-<timestamp> はゼロ詰めなので
  // 文字列順 = 時系列)。 新しい transcript から先に当てて早期 return する。
  while (stack.length > 0 && visited < MAX_DIRS_PER_SCAN && !found) {
    const dir = stack.pop()!;
    visited++;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entry.name);
    }
    files.sort().reverse();
    for (const name of files) {
      filesChecked++;
      const p = join(dir, name);
      if (transcriptHeadHasSessionId(p, sessionId)) {
        found = p;
        break;
      }
    }
    // 昇順 push → LIFO pop で最新ディレクトリから降りる。
    dirs.sort();
    for (const name of dirs) stack.push(join(dir, name));
  }

  const elapsed = now() - startedAt;
  if (elapsed >= SLOW_SCAN_WARN_MS) {
    log.warn(
      { session_id: sessionId, duration_ms: elapsed, dirs: visited, files: filesChecked, found: found !== null },
      "codex transcript scan slow",
    );
  }
  if (found) {
    foundPathCache.set(sessionId, found);
    missCache.delete(sessionId);
    return found;
  }
  missCache.set(sessionId, now() + MISS_CACHE_TTL_MS);
  return null;
}

/** ファイル先頭チャンクのみ読み、 先頭 N 行に sessionId record があるか判定する。 */
function transcriptHeadHasSessionId(path: string, sessionId: string): boolean {
  let head: string;
  try {
    head = readHead(path, HEAD_READ_BYTES);
  } catch {
    return false;
  }
  const lines = head.split(/\r?\n/);
  // チャンク境界で切れた最終行は JSON.parse が落ちて skip されるだけなので除外不要。
  for (const line of lines.slice(0, HEAD_LINES)) {
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

function readHead(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
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
