/**
 * Claude Code / Codex のローカル JSONL ログからトークン使用量を読む共通ロジック。
 *
 * cost-channel (Discord コスト表示) と cost budget (日次予算ブロック) の両方が
 * 使う。 セッション 1 本ぶんの累積トークンや、 ログファイル単位の累積トークン、
 * 「最近更新されたログファイル群」 の列挙をここに集約する。
 *
 * 値はあくまで JSONL を読んだ概算 (provider が記録した usage の合算 / スナップショット)。
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRow } from "../shared/types.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export type Totals = {
  input: number;
  cached: number;
  output: number;
  total: number;
};

/** Claude Code のプロジェクトログ親 (~/.claude/projects)。 */
export const CLAUDE_PROJECTS_ROOT = join(homedir(), ".claude", "projects");
/** Codex のセッションログ親 (~/.codex/sessions)。 */
export const CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");

/** セッション 1 本の累積トークン (provider 別ログから読む)。 取れなければ null。 */
export function readSessionUsage(s: SessionRow): Totals | null {
  if (s.provider === "codex-cli") {
    const p = findCodexLog(s);
    return p ? readCodexUsage(p) : null;
  }
  if (s.provider === "claude-code") {
    const p = findClaudeLog(s);
    return p ? readClaudeUsage(p) : null;
  }
  return null;
}

/**
 * 最近 (maxAgeMs 以内に更新された) 全ログファイルの累積トークンを列挙する。
 * 登録済みセッションに限らず、 外部バッチ / 別ツール起動の Claude/Codex ログも拾う。
 * これにより「外部作業によるトークン消費」 も予算監視の対象になる。
 */
export function enumerateRecentLogTotals(maxAgeMs: number, now: number): Array<{ path: string; total: number }> {
  const cutoff = now - maxAgeMs;
  const out: Array<{ path: string; total: number }> = [];
  collectRecent(CLAUDE_PROJECTS_ROOT, 3, cutoff, (p) => {
    const t = readClaudeUsage(p);
    if (t) out.push({ path: p, total: t.total });
  });
  collectRecent(CODEX_SESSIONS_ROOT, 5, cutoff, (p) => {
    const t = readCodexUsage(p);
    if (t) out.push({ path: p, total: t.total });
  });
  return out;
}

/** root 配下を depth まで掘り、 mtime >= cutoff の *.jsonl を visit する (best-effort)。 */
function collectRecent(root: string, depth: number, cutoff: number, visit: (p: string) => void): void {
  if (depth < 0 || !existsSync(root)) return;
  let ents: import("node:fs").Dirent[];
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      collectRecent(p, depth - 1, cutoff, visit);
    } else if (e.isFile() && p.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = statSync(p).mtimeMs;
      } catch {
        continue;
      }
      if (mtime >= cutoff) visit(p);
    }
  }
}

export function findCodexLog(s: SessionRow): string | null {
  if (!existsSync(CODEX_SESSIONS_ROOT)) return null;
  let bestPath: string | null = null;
  let bestScore = -Infinity;
  walk(CODEX_SESSIONS_ROOT, 4, (p) => {
    if (!p.endsWith(".jsonl")) return;
    const head = readCodexHead(p);
    if (!head) return;
    if (head.id === s.id) {
      bestScore = Number.POSITIVE_INFINITY;
      bestPath = p;
      return;
    }
    if (bestScore === Number.POSITIVE_INFINITY) return;
    if (head.cwd && head.cwd !== s.repo_path) return;
    const score = head.started ? -Math.abs(head.started - s.started_at) : -1e9;
    if (score > bestScore) {
      bestScore = score;
      bestPath = p;
    }
  });
  return bestPath;
}

export function findClaudeLog(s: SessionRow): string | null {
  // Claude Code は cwd を ~/.claude/projects/<encoded> に保存する。 エンコードは特殊文字
  // (`/` `\` `:` `.`) を **1 文字ずつ** `-` に置換する (隣接は潰さない)。 例 `E:/Document/Ars`
  // → `E--Document-Ars` (`:/` が `--`)。 以前は `[\\/:.]+` と `+` で隣接を 1 つに潰しており、
  // ドライブレター付き Windows パス (常に `X:\`/`X:/` を含む) で全て発見失敗していた。
  const encoded = s.repo_path.replace(/[\\/:.]/g, "-").replace(/^-+|-+$/g, "");
  const dir = join(CLAUDE_PROJECTS_ROOT, encoded);
  if (!existsSync(dir)) return null;
  const exact = join(dir, `${s.id}.jsonl`);
  if (existsSync(exact)) return exact;
  const files = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  if (files.length === 0) return null;
  let best: { p: string; score: number } | null = null;
  for (const p of files) {
    const ts = readFirstTs(p);
    const score = ts ? -Math.abs(ts - s.started_at) : -1e9;
    if (!best || score > best.score) best = { p, score };
  }
  return best?.p ?? null;
}

export function readCodexUsage(path: string): Totals | null {
  let max: Totals | null = null;
  for (const line of readLines(path)) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o) || o.type !== "event_msg") continue;
    const payload = o.payload;
    if (!isObj(payload) || payload.type !== "token_count") continue;
    const info = payload.info;
    if (!isObj(info)) continue;
    const t = info.total_token_usage;
    if (!isObj(t)) continue;
    const cur: Totals = {
      input: nn(t.input_tokens),
      cached: nn(t.cached_input_tokens),
      output: nn(t.output_tokens),
      total: nn(t.total_tokens),
    };
    if (!max || cur.total > max.total) max = cur;
  }
  return max;
}

export function readClaudeUsage(path: string): Totals | null {
  // 各 assistant 行の usage を per-message id で dedup しつつ合算する。
  // dedup key は message.id (msg_xxx)、 fallback で行 uuid。
  const seen = new Set<string>();
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const line of readLines(path)) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const msg = o.message;
    if (!isObj(msg)) continue;
    const u = msg.usage;
    if (!isObj(u)) continue;
    const dedupId =
      (typeof msg.id === "string" && msg.id) ||
      (typeof o.uuid === "string" && o.uuid) ||
      null;
    if (dedupId) {
      if (seen.has(dedupId)) continue;
      seen.add(dedupId);
    }
    out.input += nn(u.input_tokens);
    out.cached += nn(u.cache_read_input_tokens) + nn(u.cache_creation_input_tokens);
    out.output += nn(u.output_tokens);
    out.total += nn(u.input_tokens) + nn(u.output_tokens);
  }
  return out.total > 0 || out.cached > 0 ? out : null;
}

export function readCodexHead(path: string): { id: string | null; cwd: string | null; started: number | null } | null {
  for (const line of readLines(path, 20)) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o) || o.type !== "session_meta") continue;
    const payload = isObj(o.payload) ? o.payload : null;
    const id = typeof payload?.id === "string" ? payload.id : null;
    const cwd = typeof payload?.cwd === "string" ? payload.cwd : null;
    const tsRaw = typeof payload?.timestamp === "string" ? payload.timestamp : null;
    return { id, cwd, started: tsRaw ? Math.floor(new Date(tsRaw).getTime() / 1000) : null };
  }
  return null;
}

export function readFirstTs(path: string): number | null {
  for (const line of readLines(path, 20)) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const t = o.timestamp;
    if (typeof t === "string") return Math.floor(new Date(t).getTime() / 1000);
  }
  return null;
}

export function walk(root: string, depth: number, visit: (p: string) => void): void {
  if (depth < 0) return;
  let ents: import("node:fs").Dirent[];
  try {
    ents = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, depth - 1, visit);
    else if (e.isFile()) visit(p);
  }
}

export function readLines(path: string, limit?: number): string[] {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return typeof limit === "number" ? lines.slice(0, limit) : lines;
}

export function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
