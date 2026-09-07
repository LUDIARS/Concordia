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

import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
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

/**
 * セッション登録で報告された transcript が、このホストの provider 正本ログ配下に
 * 実在するときだけ返す。register API の入力を任意ファイル読取へ流さないため、
 * symlink 解決後の実体パスで判定する。
 */
export async function resolveTrustedTranscriptPath(path: string | null, root: string): Promise<string | null> {
  if (!path?.endsWith(".jsonl")) return null;
  try {
    const [resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
    const rel = relative(resolvedRoot, resolvedPath);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return resolvedPath;
  } catch {
    return null;
  }
}

/**
 * codex-sdk (Satelles) セッションの累積トークンを frame から読む。
 *
 * codex-cli の JSONL に相当するものが無いので、Satelles が turn ごとに送る
 * `codex_usage` frame が唯一の一次ソース。frame の usage は turn 単位ではなく
 * **スレッド累積** (rollout の total_token_usage と同じ意味) なので、同一
 * thread 内では合算せず最大値を採る — codex-cli 側の readCodexUsage と同じ扱い。
 *
 * ただし 1 セッションが複数 thread を持ち得る (resume / 作り直しで thread_id が
 * 変わる) ので、thread ごとに最大値を採ってから thread 間で合算する。全体の
 * 単純最大だと最大 thread 1 本ぶんしか数えず、他 thread が丸ごと落ちる。
 * thread_id を持たない frame は 1 つの無名 thread として扱う。
 */
export function readUsageFrames(payloads: readonly unknown[]): Totals | null {
  const maxByThread = new Map<string, Totals>();
  for (const payload of payloads) {
    if (!isObj(payload) || payload.type !== "codex_usage") continue;
    // JSONL リーダと違い frame は HTTP 越しに送られてくる値なので、 負数は
    // 「壊れた frame」 として 0 に潰す (負の合計を実測値として表示しない)。
    const cur: Totals = {
      input: nonNeg(payload.input_tokens),
      cached: nonNeg(payload.cached_input_tokens),
      output: nonNeg(payload.output_tokens),
      total: nonNeg(payload.total_tokens),
    };
    // total を出さない実装差に備えて内訳から補う (input は cached を含む)。
    if (cur.total === 0) cur.total = cur.input + cur.output;
    // ここまでで total が 0 = トークンが 1 つも無い frame。 0 を実測値として
    // 採ると「計測不能」と区別が付かなくなるので採らない。
    if (cur.total === 0) continue;
    const thread = typeof payload.thread_id === "string" ? payload.thread_id : "";
    const prev = maxByThread.get(thread);
    if (!prev || cur.total > prev.total) maxByThread.set(thread, cur);
  }
  if (maxByThread.size === 0) return null;
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const t of maxByThread.values()) {
    out.input += t.input;
    out.cached += t.cached;
    out.output += t.output;
    out.total += t.total;
  }
  return out;
}

/** frame からセッション使用量を読むための最小依存 (テストで差し替える)。 */
export interface UsageFrameSource {
  listUsagePayloads(sessionId: string, limit?: number): unknown[];
}

/**
 * セッション 1 本の累積トークン (provider 別ログから読む)。 取れなければ null。
 *
 * codex-sdk は frames にしか usage が無いため、frame ソースを渡されたときだけ
 * 集計できる (渡されなければ従来どおり null = 未計測)。
 */
export async function readSessionUsage(
  s: SessionRow,
  frames?: UsageFrameSource,
): Promise<Totals | null> {
  if (s.provider === "codex-cli") {
    const p = await resolveSessionTranscript(s);
    return p ? readCodexUsage(p) : null;
  }
  if (s.provider === "claude-code") {
    const p = await resolveSessionTranscript(s);
    return p ? readClaudeUsage(p) : null;
  }
  if (s.provider === "codex-sdk") {
    return frames ? readUsageFrames(frames.listUsagePayloads(s.id)) : null;
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

/**
 * セッションが実際に読み書きしている transcript を解決する。 **これが唯一の経路**で、
 * 推測 (開始時刻の近さ・cwd 一致・mtime) は一切しない。 解決できなければ null。
 *
 * 以前は「repo_path から引いたディレクトリで開始時刻がいちばん近い JSONL」を選ぶ
 * 独自ロジックを持っていた。 排他が無いので複数セッションが同じファイルを掴む。
 * 実測 (2026-09-07、直近 5 日の claude-code セッション 148 本を登録済み
 * transcript_path と突き合わせ): 誤り 18 本 (12%)、 解決不能 15 本。 うち 2 組は
 * **秒差で起動したセッションが同一ファイルを共有**していた。 コンテキスト占有が
 * 他人の値になり、 「複数セッションに同時に警告が出る」「起動直後から警告が出る」
 * という形で表面化していた。
 *
 * 束縛先を決めているのは Lictor で、 provider ごとの権威 (Claude=SessionStart hook /
 * Codex=App Server thread / ローカル LLM=filename 施錠) は向こうで確定している。
 * その報告 (`PATCH /v1/sessions/:id { transcript_path }`) だけを信じる。 Lictor 自身も
 * 同じ理由で mtime 推測を捨てている (`transcript-tail.ts`: 「mtime 推測は crosstalk 源
 * なので一切しない」)。 ここに別ロジックを持たせない。
 *
 * 報告が無い = 推定不能。 他人のログで埋め合わせない (誤った数字は無い数字より悪い)。
 */
export async function resolveSessionTranscript(s: SessionRow): Promise<string | null> {
  if (s.provider === "claude-code") {
    return resolveTrustedTranscriptPath(s.transcript_path, CLAUDE_PROJECTS_ROOT);
  }
  if (s.provider === "codex-cli") {
    return resolveTrustedTranscriptPath(s.transcript_path, CODEX_SESSIONS_ROOT);
  }
  return null;
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

/**
 * JSONL の行配列を読む。 limit 指定時は先頭チャンク (HEAD_CHUNK_BYTES) のみ読み、
 * 足りた場合はファイル全量を読まない (head 用途)。
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

/** nn の非負版 (負のトークン数を持つ壊れた入力を 0 に潰す)。 */
function nonNeg(v: unknown): number {
  return Math.max(0, nn(v));
}
