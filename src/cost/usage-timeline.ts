/**
 * セッション 1 本の消費を時刻つきで読む (spec/feature/usage-budgets.md §3.2)。
 *
 * 月次予算の「指示を出した人ごとの帰属」に使う。 合計は log-usage.ts の readClaudeUsage / readCodexUsage と
 * 同じ数え方 (Claude は message id で重複を除いた input + output、 Codex は累積の最大) を時刻つきの点に分けたもの。
 * 時刻が取れない provider (codex-sdk など) やログが読めないときは null を返し、 呼び出し側は従来どおり
 * セッションの起動時の帰属先へまとめて付ける。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { SessionRow } from "../shared/types.js";
import { nn, readLines, resolveSessionTranscript } from "./log-usage.js";

/** 消費の 1 点 (atMs = epoch ms)。 */
export interface UsagePoint {
  atMs: number;
  tokens: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Claude Code の transcript 行から、 assistant の usage を時刻つきで取り出す。 時刻の無い行は捨てる。 */
export function claudeUsagePoints(lines: readonly string[]): UsagePoint[] {
  const seen = new Set<string>();
  const points: UsagePoint[] = [];
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o) || !isObj(o.message) || !isObj(o.message.usage)) continue;
    const msg = o.message;
    const usage = msg.usage as Record<string, unknown>;
    const dedupId = (typeof msg.id === "string" && msg.id) || (typeof o.uuid === "string" && o.uuid) || null;
    if (dedupId) {
      if (seen.has(dedupId)) continue;
      seen.add(dedupId);
    }
    const atMs = timestampMs(o.timestamp);
    const tokens = nn(usage.input_tokens) + nn(usage.output_tokens);
    if (atMs === null || tokens <= 0) continue;
    points.push({ atMs, tokens });
  }
  return points;
}

/** Codex の rollout 行から、 累積 (total_token_usage) の増分を時刻つきで取り出す。 */
export function codexUsagePoints(lines: readonly string[]): UsagePoint[] {
  let previous = 0;
  const points: UsagePoint[] = [];
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(o) || o.type !== "event_msg" || !isObj(o.payload) || o.payload.type !== "token_count") continue;
    const info = o.payload.info;
    if (!isObj(info) || !isObj(info.total_token_usage)) continue;
    const total = nn(info.total_token_usage.total_tokens);
    // 累積は単調増加のはずだが、 巻き戻った値は増分 0 として扱う (最大値の数え方と合わせる)。
    if (total <= previous) continue;
    const atMs = timestampMs(o.timestamp);
    if (atMs !== null) points.push({ atMs, tokens: total - previous });
    previous = total;
  }
  return points;
}

/** セッションの消費を時刻つきで読む。 読めなければ null (呼び出し側はセッション全体の合計に倒す)。 */
export async function readSessionUsageTimeline(session: SessionRow): Promise<UsagePoint[] | null> {
  if (session.provider !== "claude-code" && session.provider !== "codex-cli") return null;
  const path = await resolveSessionTranscript(session);
  if (!path) return null;
  const lines = await readLines(path);
  const points = session.provider === "claude-code" ? claudeUsagePoints(lines) : codexUsagePoints(lines);
  return points.length > 0 ? points : null;
}
