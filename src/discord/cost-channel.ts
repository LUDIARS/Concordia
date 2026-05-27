import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";

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
};

export async function upsertCostChannelMessage(
  channel: TextChannel,
  sessionsRepo: SessionsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
): Promise<void> {
  const active = sessionsRepo.listSessions({ status: "active" });
  const codex = active.filter((s) => s.provider === "codex-cli");
  const claude = active.filter((s) => s.provider === "claude-code");

  const codexTotals = aggregate(codex);
  const claudeTotals = aggregate(claude);
  const codexRate = aggregateCodexRate(codex);

  const lines: string[] = [];
  lines.push("## コスト / 使用量");
  lines.push(`- Updated: <t:${Math.floor(Date.now() / 1000)}:R>`);
  lines.push("");
  lines.push("### Codex");
  lines.push(`- Tokens: ${fmt(codexTotals.total)} (in=${fmt(codexTotals.input)}, cached=${fmt(codexTotals.cached)}, out=${fmt(codexTotals.output)})`);
  lines.push(`- 5H リミット残: ${pct(remain(codexRate.used5h))}`);
  lines.push(`- 週間リミット残: ${pct(remain(codexRate.usedWeekly))}`);
  lines.push("");
  lines.push("### Claude Code");
  lines.push(`- Tokens: ${fmt(claudeTotals.total)} (in=${fmt(claudeTotals.input)}, cached=${fmt(claudeTotals.cached)}, out=${fmt(claudeTotals.output)})`);
  lines.push("- 5H リミット残: -");
  lines.push("- 週間リミット残: -");
  lines.push("");
  lines.push("_セッション単位の表示は省略。プロバイダ別集計のみ表示。_");
  const body = lines.join("\n").slice(0, 3900);

  const msgId = configGet(COST_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ content: body });
      return;
    }
  } catch {}
  const sent = await channel.send({ content: body });
  configSet(COST_MESSAGE_KEY, sent.id);
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
  for (const s of sessions) {
    const r = readCodexRate(s);
    if (!r) continue;
    const r5 = remain(r.used5h);
    const rw = remain(r.usedWeekly);
    if (r5 !== null) minRemain5h = minRemain5h === null ? r5 : Math.min(minRemain5h, r5);
    if (rw !== null) minRemainWeekly = minRemainWeekly === null ? rw : Math.min(minRemainWeekly, rw);
  }
  return {
    used5h: minRemain5h === null ? null : 100 - minRemain5h,
    usedWeekly: minRemainWeekly === null ? null : 100 - minRemainWeekly,
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
  const seen = new Set<string>();
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const line of readLines(path)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const reqId = typeof o?.requestId === "string" ? o.requestId : null;
    if (!reqId || seen.has(reqId)) continue;
    const u = o?.message?.usage;
    if (!u) continue;
    seen.add(reqId);
    out.input += nn(u.input_tokens);
    out.cached += nn(u.cache_read_input_tokens) + nn(u.cache_creation_input_tokens);
    out.output += nn(u.output_tokens);
    out.total += nn(u.input_tokens) + nn(u.output_tokens);
  }
  return out.total > 0 || out.cached > 0 ? out : null;
}

function readCodexHead(path: string): { cwd: string | null; started: number | null } | null {
  for (const line of readLines(path, 20)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "session_meta") continue;
    const cwd = typeof o?.payload?.cwd === "string" ? o.payload.cwd : null;
    const tsRaw = typeof o?.payload?.timestamp === "string" ? o.payload.timestamp : null;
    return { cwd, started: tsRaw ? Math.floor(new Date(tsRaw).getTime() / 1000) : null };
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
