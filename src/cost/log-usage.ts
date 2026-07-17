/**
 * Claude Code / Codex のローカル JSONL ログからトークン使用量を読む共通ロジック。
 *
 * cost-channel (Discord コスト表示) と cost budget (日次予算ブロック) の両方が
 * 使う。 セッション 1 本ぶんの累積トークンや、 ログファイル単位の累積トークン、
 * 「最近更新されたログファイル群」 の列挙をここに集約する。
 *
 * 値はあくまで JSONL を読んだ概算 (provider が記録した usage の合算 / スナップショット)。
 *
 * I/O は全て fs/promises (完全非同期)。 同期 fs はイベントループを止めるため禁止
 * (2026-07-16/17 障害: readdirSync+readFileSync の全量走査で 8〜110 秒停止)。
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
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

/** head 読み (limit 付き readLines) で読む先頭チャンクのバイト数。 */
const HEAD_CHUNK_BYTES = 256 * 1024;

/** path が存在するか (async existsSync 代替)。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** セッション 1 本の累積トークン (provider 別ログから読む)。 取れなければ null。 */
export async function readSessionUsage(s: SessionRow): Promise<Totals | null> {
  if (s.provider === "codex-cli") {
    const p = await findCodexLog(s);
    return p ? readCodexUsage(p) : null;
  }
  if (s.provider === "claude-code") {
    const p = await findClaudeLog(s);
    return p ? readClaudeUsage(p) : null;
  }
  return null;
}

/**
 * 最近 (maxAgeMs 以内に更新された) 全ログファイルの累積トークンを列挙する。
 * 登録済みセッションに限らず、 外部バッチ / 別ツール起動の Claude/Codex ログも拾う。
 * これにより「外部作業によるトークン消費」 も予算監視の対象になる。
 */
export async function enumerateRecentLogTotals(maxAgeMs: number, now: number): Promise<Array<{ path: string; total: number }>> {
  const cutoff = now - maxAgeMs;
  const out: Array<{ path: string; total: number }> = [];
  await collectRecent(CLAUDE_PROJECTS_ROOT, 3, cutoff, async (p) => {
    const t = await readClaudeUsage(p);
    if (t) out.push({ path: p, total: t.total });
  });
  await collectRecent(CODEX_SESSIONS_ROOT, 5, cutoff, async (p) => {
    const t = await readCodexUsage(p);
    if (t) out.push({ path: p, total: t.total });
  });
  return out;
}

/** root 配下を depth まで掘り、 mtime >= cutoff の *.jsonl を visit する (best-effort)。 */
export async function collectRecent(
  root: string,
  depth: number,
  cutoff: number,
  visit: (p: string) => void | Promise<void>,
): Promise<void> {
  if (depth < 0) return;
  let ents: Dirent[];
  try {
    ents = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      await collectRecent(p, depth - 1, cutoff, visit);
    } else if (e.isFile() && p.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = (await stat(p)).mtimeMs;
      } catch {
        continue;
      }
      if (mtime >= cutoff) await visit(p);
    }
  }
}

export async function findCodexLog(s: SessionRow): Promise<string | null> {
  if (!(await pathExists(CODEX_SESSIONS_ROOT))) return null;
  let bestPath: string | null = null;
  let bestScore = -Infinity;
  await walk(CODEX_SESSIONS_ROOT, 4, async (p) => {
    if (!p.endsWith(".jsonl")) return;
    if (bestScore === Number.POSITIVE_INFINITY) return;
    const head = await readCodexHead(p);
    if (!head) return;
    if (head.id === s.id) {
      bestScore = Number.POSITIVE_INFINITY;
      bestPath = p;
      return;
    }
    if (head.cwd && head.cwd !== s.repo_path) return;
    const score = head.started ? -Math.abs(head.started - s.started_at) : -1e9;
    if (score > bestScore) {
      bestScore = score;
      bestPath = p;
    }
  });
  return bestPath;
}

export async function findClaudeLog(s: SessionRow): Promise<string | null> {
  // Claude Code は cwd を ~/.claude/projects/<encoded> に保存する。 エンコードは特殊文字
  // (`/` `\` `:` `.`) を **1 文字ずつ** `-` に置換する (隣接は潰さない)。 例 `E:/Document/Ars`
  // → `E--Document-Ars` (`:/` が `--`)。 以前は `[\\/:.]+` と `+` で隣接を 1 つに潰しており、
  // ドライブレター付き Windows パス (常に `X:\`/`X:/` を含む) で全て発見失敗していた。
  const encoded = s.repo_path.replace(/[\\/:.]/g, "-").replace(/^-+|-+$/g, "");
  const dir = join(CLAUDE_PROJECTS_ROOT, encoded);
  if (!(await pathExists(dir))) return null;
  const exact = join(dir, `${s.id}.jsonl`);
  if (await pathExists(exact)) return exact;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const files = names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
  if (files.length === 0) return null;
  let best: { p: string; score: number } | null = null;
  for (const p of files) {
    const ts = await readFirstTs(p);
    const score = ts ? -Math.abs(ts - s.started_at) : -1e9;
    if (!best || score > best.score) best = { p, score };
  }
  return best?.p ?? null;
}

export async function readCodexUsage(path: string): Promise<Totals | null> {
  let max: Totals | null = null;
  for (const line of await readLines(path)) {
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

export async function readClaudeUsage(path: string): Promise<Totals | null> {
  // 各 assistant 行の usage を per-message id で dedup しつつ合算する。
  // dedup key は message.id (msg_xxx)、 fallback で行 uuid。
  const seen = new Set<string>();
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const line of await readLines(path)) {
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

export async function readCodexHead(path: string): Promise<{ id: string | null; cwd: string | null; started: number | null } | null> {
  for (const line of await readLines(path, 20)) {
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

export async function readFirstTs(path: string): Promise<number | null> {
  for (const line of await readLines(path, 20)) {
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

export async function walk(root: string, depth: number, visit: (p: string) => void | Promise<void>): Promise<void> {
  if (depth < 0) return;
  let ents: Dirent[];
  try {
    ents = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isDirectory()) await walk(p, depth - 1, visit);
    else if (e.isFile()) await visit(p);
  }
}

/**
 * JSONL の行配列を読む。 limit 指定時は先頭チャンク (HEAD_CHUNK_BYTES) のみ読み、
 * 足りた場合はファイル全量を読まない (head 用途: readCodexHead / readFirstTs)。
 * チャンクで limit 行に満たず、 かつファイルがチャンクより大きい場合のみ全読みに
 * フォールバックする。
 */
export async function readLines(path: string, limit?: number): Promise<string[]> {
  if (typeof limit === "number") {
    const head = await readHeadChunk(path, HEAD_CHUNK_BYTES);
    if (head === null) return [];
    const headLines = head.text.split(/\r?\n/).filter((l) => l.trim());
    if (headLines.length >= limit || head.coveredWholeFile) {
      return headLines.slice(0, limit);
    }
    // 巨大行でチャンク内に limit 行が無い稀ケースのみ全読み。
  }
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return typeof limit === "number" ? lines.slice(0, limit) : lines;
}

async function readHeadChunk(path: string, maxBytes: number): Promise<{ text: string; coveredWholeFile: boolean } | null> {
  try {
    const fh = await open(path, "r");
    try {
      const size = (await fh.stat()).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      return { text: buf.toString("utf8", 0, bytesRead), coveredWholeFile: bytesRead >= size };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
