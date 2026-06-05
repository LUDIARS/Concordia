import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { fetchClaudeOAuthUsage, type OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { createChildLogger } from "../shared/logger.js";

const oauthUsageLog = createChildLogger("cost-channel.oauth-usage");

const COST_MESSAGE_KEY = "cost_status_message_id";

type Totals = {
  input: number;
  cached: number;
  output: number;
  total: number;
};

type Rate = {
  used5h: number | null;
  usedWeekly: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
};

export async function upsertCostChannelMessage(
  channel: TextChannel,
  sessionsRepo: SessionsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  activityChannel?: TextChannel | null,
): Promise<void> {
  const active = sessionsRepo.listSessions({ status: "active" });
  const codex = active.filter((s) => s.provider === "codex-cli");
  const claude = active.filter((s) => s.provider === "claude-code");

  const codexTotals = aggregate(codex);
  const claudeTotals = aggregate(claude);
  const codexRate = aggregateCodexRate(codex);
  // Claude Code は JSONL に rate-limit を書かないので、 claude.ai OAuth の
  // `/api/oauth/usage` を直接叩いて 5H / 7D / Sonnet / Opus 利用率を取る.
  const claudeUsage = await fetchClaudeOAuthUsage({ log: oauthUsageLog });

  const lines: string[] = [];
  lines.push("## コスト / 使用量");
  lines.push(`- Updated: <t:${Math.floor(Date.now() / 1000)}:R>`);
  lines.push("");
  lines.push("### Codex");
  lines.push(`- Tokens: ${fmt(codexTotals.total)} (in=${fmt(codexTotals.input)}, cached=${fmt(codexTotals.cached)}, out=${fmt(codexTotals.output)})`);
  lines.push(`- 5H リミット残: ${pct(remain(codexRate.used5h))}`);
  lines.push(`- 週間リミット残: ${pct(remain(codexRate.usedWeekly))}`);
  lines.push(`- 5H リセット: ${ts(codexRate.reset5hAt)}`);
  lines.push(`- 週間リセット: ${ts(codexRate.resetWeeklyAt)}`);
  lines.push("");
  lines.push("### Claude Code");
  lines.push(`- Tokens: ${fmt(claudeTotals.total)} (in=${fmt(claudeTotals.input)}, cached=${fmt(claudeTotals.cached)}, out=${fmt(claudeTotals.output)})`);
  // 残量は claude.ai OAuth `/api/oauth/usage` 由来. accessToken は
  // ~/.claude/.credentials.json から都度読む (DB に保存しない)。
  // 取得失敗時は "-" にフォールバック.
  if (claudeUsage) {
    lines.push(`- 5H リミット残: ${pct(remain(claudeUsage.fiveHour?.utilization ?? null))}`);
    lines.push(`- 週間リミット残: ${pct(remain(claudeUsage.sevenDay?.utilization ?? null))}`);
    lines.push(`- 5H リセット: ${ts(claudeUsage.fiveHour?.resetsAtSec ?? null)}`);
    lines.push(`- 週間リセット: ${ts(claudeUsage.sevenDay?.resetsAtSec ?? null)}`);
    // モデル別 7日: Sonnet / Opus は Max 20x など上位プランで個別 quota あり
    if (claudeUsage.sevenDaySonnet) {
      lines.push(`- 週間 Sonnet 残: ${pct(remain(claudeUsage.sevenDaySonnet.utilization))} (リセット ${ts(claudeUsage.sevenDaySonnet.resetsAtSec)})`);
    }
    if (claudeUsage.sevenDayOpus) {
      lines.push(`- 週間 Opus 残: ${pct(remain(claudeUsage.sevenDayOpus.utilization))} (リセット ${ts(claudeUsage.sevenDayOpus.resetsAtSec)})`);
    }
    if (claudeUsage.extraCredit.isEnabled && claudeUsage.extraCredit.utilization !== null) {
      lines.push(`- 追加クレジット使用率: ${pct(claudeUsage.extraCredit.utilization)}`);
    }
  } else {
    lines.push("- 5H リミット残: - (OAuth usage 取得失敗)");
    lines.push("- 週間リミット残: -");
    lines.push("- 5H リセット: -");
    lines.push("- 週間リセット: -");
  }
  lines.push("");
  lines.push("_セッション単位の表示は省略。プロバイダ別集計のみ表示。_");
  const body = lines.join("\n").slice(0, 3900);

  const msgId = configGet(COST_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ content: body });
      await notifyCostActivity({
        activityChannel,
        configGet,
        configSet,
        codexRate,
        claudeUsage,
      });
      return;
    }
  } catch {}
  const sent = await channel.send({ content: body });
  configSet(COST_MESSAGE_KEY, sent.id);

  await notifyCostActivity({
    activityChannel,
    configGet,
    configSet,
    codexRate,
    claudeUsage,
  });
}

async function notifyCostActivity(input: {
  activityChannel?: TextChannel | null;
  configGet: (k: string) => string | null;
  configSet: (k: string, v: string) => void;
  codexRate: Rate;
  claudeUsage: OAuthUsage | null;
}): Promise<void> {
  const { activityChannel, configGet, configSet, codexRate, claudeUsage } = input;
  if (!activityChannel) return;

  const codex5h = codexRate.used5h;
  const claude5h = claudeUsage?.fiveHour?.utilization ?? null;
  const available = codex5h !== null || claude5h !== null;
  const prevAvailability = configGet("cost_activity:available");
  if (prevAvailability === "0" && available) {
    await activityChannel.send("✅ cost usage is available again.");
  }
  configSet("cost_activity:available", available ? "1" : "0");

  await notifyHigh5hUsage(activityChannel, configGet, configSet, {
    provider: "Codex",
    used5h: codex5h,
    reset5hAt: codexRate.reset5hAt,
  });
  await notifyHigh5hUsage(activityChannel, configGet, configSet, {
    provider: "Claude",
    used5h: claude5h,
    reset5hAt: claudeUsage?.fiveHour?.resetsAtSec ?? null,
  });
}

async function notifyHigh5hUsage(
  activityChannel: TextChannel,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  input: { provider: string; used5h: number | null; reset5hAt: number | null },
): Promise<void> {
  if (input.used5h === null || input.used5h < 80) return;
  const resetBucket = input.reset5hAt ? String(input.reset5hAt) : localDayBucket();
  const key = `cost_activity:5h80:${input.provider.toLowerCase()}`;
  if (configGet(key) === resetBucket) return;
  configSet(key, resetBucket);
  await activityChannel.send(
    `⚠️ ${input.provider} 5H cost usage is ${input.used5h.toFixed(1)}%` +
    (input.reset5hAt ? ` (resets ${ts(input.reset5hAt)})` : ""),
  );
}

function localDayBucket(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function aggregate(sessions: SessionRow[]): Totals {
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const s of sessions) {
    const t = readUsage(s);
    if (!t) continue;
    out.input += t.input;
    out.cached += t.cached;
    out.output += t.output;
    out.total += t.total;
  }
  return out;
}

function aggregateCodexRate(sessions: SessionRow[]): Rate {
  let minRemain5h: number | null = null;
  let minRemainWeekly: number | null = null;
  let minReset5h: number | null = null;
  let minResetWeekly: number | null = null;
  for (const s of sessions) {
    const r = readCodexRate(s);
    if (!r) continue;
    const r5 = remain(r.used5h);
    const rw = remain(r.usedWeekly);
    if (r5 !== null) minRemain5h = minRemain5h === null ? r5 : Math.min(minRemain5h, r5);
    if (rw !== null) minRemainWeekly = minRemainWeekly === null ? rw : Math.min(minRemainWeekly, rw);
    if (r.reset5hAt !== null) minReset5h = minReset5h === null ? r.reset5hAt : Math.min(minReset5h, r.reset5hAt);
    if (r.resetWeeklyAt !== null) minResetWeekly = minResetWeekly === null ? r.resetWeeklyAt : Math.min(minResetWeekly, r.resetWeeklyAt);
  }
  return {
    used5h: minRemain5h === null ? null : 100 - minRemain5h,
    usedWeekly: minRemainWeekly === null ? null : 100 - minRemainWeekly,
    reset5hAt: minReset5h,
    resetWeeklyAt: minResetWeekly,
  };
}

function readUsage(s: SessionRow): Totals | null {
  if (s.provider === "codex-cli") {
    const p = findCodexLog(s);
    if (!p) return null;
    return readCodexUsage(p);
  }
  if (s.provider === "claude-code") {
    const p = findClaudeLog(s);
    if (!p) return null;
    return readClaudeUsage(p);
  }
  return null;
}

function readCodexRate(s: SessionRow): Rate | null {
  const p = findCodexLog(s);
  if (!p) return null;
  let latest: Rate | null = null;
  for (const line of readLines(p)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "event_msg" || o?.payload?.type !== "token_count") continue;
    latest = {
      used5h: nnull(o?.payload?.rate_limits?.primary?.used_percent),
      usedWeekly: nnull(o?.payload?.rate_limits?.secondary?.used_percent),
      reset5hAt: nnEpoch(o?.payload?.rate_limits?.primary?.resets_at),
      resetWeeklyAt: nnEpoch(o?.payload?.rate_limits?.secondary?.resets_at),
    };
  }
  return latest;
}

function findCodexLog(s: SessionRow): string | null {
  const root = join(homedir(), ".codex", "sessions");
  if (!existsSync(root)) return null;
  let bestPath: string | null = null;
  let bestScore = -Infinity;
  walk(root, 4, (p) => {
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

function findClaudeLog(s: SessionRow): string | null {
  const encoded = s.repo_path.replace(/[\\/:.]+/g, "-").replace(/^-+|-+$/g, "");
  const dir = join(homedir(), ".claude", "projects", encoded);
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

function readCodexUsage(path: string): Totals | null {
  let max: Totals | null = null;
  for (const line of readLines(path)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "event_msg" || o?.payload?.type !== "token_count") continue;
    const t = o?.payload?.info?.total_token_usage;
    if (!t) continue;
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

function readClaudeUsage(path: string): Totals | null {
  // Claude Code JSONL の assistant 行サンプル:
  //   {"parentUuid":"...","isSidechain":false,"message":{"id":"msg_xxx",
  //    "model":"claude-opus-4-7","role":"assistant","content":[...],
  //    "usage":{"input_tokens":N,"cache_read_input_tokens":N,
  //             "cache_creation_input_tokens":N,"output_tokens":N}}, ...}
  //
  // 旧実装は `o.requestId` を dedup key にしていたが、 そのフィールドは
  // 存在しない (確認: 2026-05-27 実機 JSONL)。 全 line が seen check で
  // 弾かれて usage が 1 件も加算されない → Tokens=0 になっていた。
  //
  // 真の per-message 識別子は `o.message.id` (msg_xxx) で、 同じ API call
  // が複数行に複製された場合の重複加算もこれで防げる。 fallback として
  // 上位の `o.uuid` (per-line uuid) を使うことで、 message.id が無い行
  // (旧 schema / 部分行) も同一行を二重に数えない。
  const seen = new Set<string>();
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const line of readLines(path)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    if (!u) continue;
    const dedupId =
      (typeof o?.message?.id === "string" && o.message.id) ||
      (typeof o?.uuid === "string" && o.uuid) ||
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

function readCodexHead(path: string): { id: string | null; cwd: string | null; started: number | null } | null {
  for (const line of readLines(path, 20)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "session_meta") continue;
    const id = typeof o?.payload?.id === "string" ? o.payload.id : null;
    const cwd = typeof o?.payload?.cwd === "string" ? o.payload.cwd : null;
    const tsRaw = typeof o?.payload?.timestamp === "string" ? o.payload.timestamp : null;
    return { id, cwd, started: tsRaw ? Math.floor(new Date(tsRaw).getTime() / 1000) : null };
  }
  return null;
}

function readFirstTs(path: string): number | null {
  for (const line of readLines(path, 20)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const t = o?.timestamp;
    if (typeof t === "string") return Math.floor(new Date(t).getTime() / 1000);
  }
  return null;
}

function walk(root: string, depth: number, visit: (p: string) => void): void {
  if (depth < 0) return;
  let ents: import("node:fs").Dirent[];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p, depth - 1, visit);
    else if (e.isFile()) visit(p);
  }
}

function readLines(path: string, limit?: number): string[] {
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return typeof limit === "number" ? lines.slice(0, limit) : lines;
}

function nn(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function nnull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nnEpoch(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function remain(used: number | null): number | null {
  if (used === null) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

function pct(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(1)}%`;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function ts(epochSec: number | null): string {
  return epochSec === null ? "-" : `<t:${epochSec}:f> (<t:${epochSec}:R>)`;
}
