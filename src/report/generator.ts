/**
 * セッション終了レポート生成.
 *
 * - bullets: 構造化集計 (events count / files / todos / outcome)
 * - summary_md: claude CLI (claude -p) で narrative 生成 → fallback で template
 *   (LUDIARS は API 不使用のため Anthropic API 直叩き経路は撤去済み)
 *
 * spec/service-schema.md §7 準拠.
 */

import type { SessionEventRow, SessionReportRow, SessionRow } from "../shared/types.js";
import { runClaude } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";
import {
  summarizeSessionUsage,
  renderUsageMarkdown,
  type SessionUsageSummary,
} from "../cost/session-cost.js";
import { detectSummaryFlags, renderSummaryFlagsMarkdown, hasFlags } from "./summary-flags.js";

const log = createChildLogger("report");

export interface ReportBullets {
  duration_sec: number;
  events: Record<string, number>;
  files: { edited: string[]; created: string[]; deleted: string[] };
  todos: { completed: number; in_progress: number; pending: number };
  branches: string[];
  outcome: "ended" | "lost" | "abandoned";
}

export function aggregateBullets(
  session: SessionRow,
  events: SessionEventRow[],
): ReportBullets {
  const counts: Record<string, number> = {};
  const editedFiles = new Set<string>();
  const createdFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  const branches = new Set<string>();
  let todos = { completed: 0, in_progress: 0, pending: 0 };

  for (const ev of events) {
    counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
    let payload: any;
    try {
      payload = JSON.parse(ev.payload);
    } catch {
      continue;
    }
    if (ev.kind === "edit" && typeof payload?.file === "string") {
      if (payload.created) createdFiles.add(payload.file);
      else if (payload.deleted) deletedFiles.add(payload.file);
      else editedFiles.add(payload.file);
    }
    if (ev.kind === "task_update" && payload && Array.isArray(payload.todos)) {
      const t = countTodos(payload.todos);
      todos = t;
    }
  }
  if (session.branch) branches.add(session.branch);

  const endedAt = session.ended_at ?? session.last_seen_at;
  const duration_sec = Math.max(0, endedAt - session.started_at);

  const outcome: ReportBullets["outcome"] =
    session.status === "ended"
      ? "ended"
      : session.status === "abandoned"
        ? "abandoned"
        : "lost";

  return {
    duration_sec,
    events: counts,
    files: {
      edited: [...editedFiles],
      created: [...createdFiles],
      deleted: [...deletedFiles],
    },
    todos,
    branches: [...branches],
    outcome,
  };
}

export function templateSummary(
  session: SessionRow,
  b: ReportBullets,
  usage?: SessionUsageSummary,
): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id}`);
  lines.push("");
  lines.push(`- **provider**: \`${session.provider}\``);
  lines.push(`- **repo**: \`${session.repo_origin ?? session.repo_path}\``);
  if (b.branches.length) lines.push(`- **branch**: ${b.branches.join(", ")}`);
  lines.push(`- **host**: ${session.host}`);
  lines.push(`- **duration**: ${formatDuration(b.duration_sec)}`);
  lines.push(`- **outcome**: ${b.outcome}`);
  lines.push("");
  lines.push(`## Activity`);
  for (const [kind, n] of Object.entries(b.events).sort((a, c) => c[1] - a[1])) {
    lines.push(`- ${kind}: ${n}`);
  }
  if (b.files.edited.length || b.files.created.length || b.files.deleted.length) {
    lines.push("");
    lines.push(`## Files`);
    if (b.files.edited.length)  lines.push(`- edited: ${b.files.edited.length} (${b.files.edited.slice(0, 5).join(", ")}${b.files.edited.length > 5 ? ", …" : ""})`);
    if (b.files.created.length) lines.push(`- created: ${b.files.created.length}`);
    if (b.files.deleted.length) lines.push(`- deleted: ${b.files.deleted.length}`);
  }
  if (b.todos.completed + b.todos.in_progress + b.todos.pending > 0) {
    lines.push("");
    lines.push(`## Todos`);
    lines.push(`- completed: ${b.todos.completed}`);
    lines.push(`- in_progress: ${b.todos.in_progress}`);
    lines.push(`- pending: ${b.todos.pending}`);
  }
  if (usage) {
    const usageLines = renderUsageMarkdown(usage);
    if (usageLines.length) {
      lines.push("");
      lines.push(...usageLines);
    }
  }
  return lines.join("\n");
}

export async function generateReport(
  session: SessionRow,
  events: SessionEventRow[],
): Promise<SessionReportRow> {
  const bullets = aggregateBullets(session, events);
  // 想定コスト + コンテキスト占有を 1 回だけ概算し、 業務報告セクションに載せる
  // (provider ログ読み。 取れなければ各フィールドが null になり該当行を省く)。
  const usage = summarizeSessionUsage(session);

  // 優先: claude CLI (claude -p) で narrative
  let summary_md: string | null = await narrativeViaCli(session, events, bullets, usage);

  // fallback: template (3 セクション構造を保つため poem / summary placeholder を被せる)
  if (!summary_md) {
    summary_md = fallbackThreeSection(session, bullets, usage);
  }

  // ④ サマリー検出: ハーネスブロック / 人間確認事項を Sonnet で抽出し別建てで載せる。
  // needsHuman 通知 (起因者メンション) は呼び出し側 (end-session-flow) が metadata から拾う。
  const flags = await detectSummaryFlags(session, events);
  const flagLines = renderSummaryFlagsMarkdown(flags);
  if (flagLines.length) summary_md = `${summary_md}\n\n${flagLines.join("\n")}`;

  return {
    session_id: session.id,
    generated_at: nowSec(),
    summary_md,
    bullets: JSON.stringify(bullets),
    duration_sec: bullets.duration_sec,
    metadata: hasFlags(flags) ? JSON.stringify({ summary_flags: flags }) : null,
  };
}

/**
 * AI narrative が両方失敗したときの fallback. poem / summary は出せないので
 * 「生成できなかった」 と明記した placeholder を入れて 3 セクション構造だけ保つ.
 * extractMonologue が `\n---` 前で切るので poem セクションは独白として #報告 channel に流れる.
 */
function fallbackThreeSection(
  session: SessionRow,
  bullets: ReportBullets,
  usage?: SessionUsageSummary,
): string {
  const role = parseMetadata(session.metadata).role_label ?? "雑用係";
  const dur = formatDuration(bullets.duration_sec);
  const poemPlaceholder = [
    `(${role} は今回ポエムを綴れなかった — AI narrative 生成失敗)`,
    `${dur} の作業ログ. ${bullets.outcome}.`,
  ].join("\n");
  const summaryPlaceholder =
    "narrative 生成 (claude CLI) が失敗したため、 構造化集計のみ.";
  const middle = templateSummary(session, bullets, usage);
  return [
    poemPlaceholder,
    "",
    "---",
    "",
    middle.trim(),
    "",
    "---",
    "",
    "## サマリ",
    "",
    summaryPlaceholder,
  ].join("\n");
}

async function narrativeViaCli(
  session: SessionRow,
  events: SessionEventRow[],
  bullets: ReportBullets,
  usage?: SessionUsageSummary,
): Promise<string | null> {
  if (process.env.CONCORDIA_DISABLE_CLAUDE === "1") return null;

  const meta = parseMetadata(session.metadata);
  const role = meta.role_label ?? "雑用係";

  const compactEvents = events
    .filter((e) => ["prompt", "edit", "tool_call", "task_update", "compact", "lost", "recovered"].includes(e.kind))
    .slice(-40)
    .map((e) => ({
      kind: e.kind,
      ts: e.ts,
      ago_sec: nowSec() - e.ts,
      payload: safeParse(e.payload),
    }));

  // 真ん中の業務報告は server で deterministic に組み立てる (templateSummary).
  // AI には (1) ポエムと (3) 200 字サマリだけ JSON で生成させる.
  const prompt = [
    `あなたはこのセッションの「${role}」として、 日報の 「冒頭ポエム」 と 「末尾サマリ」 だけを書きます.`,
    "出力は **JSON のみ**. 余計な前置きや code fence なし.",
    "",
    "## 出力スキーマ",
    `{"poem": "<4-8 行の詩>", "summary": "<200字程度の総括>"}`,
    "",
    "## poem (冒頭) について",
    "- 4〜8 行の散文詩 / つぶやき.",
    "- 業務内容 (repo / branch / event 傾向 / lost) を **比喩 / 情景 / 心情** で書く.",
    "- 直接的な数字 / file パスは出さず、 「触れた糸」「降り積もる commit」 のような象徴で.",
    "- 字下げや絵文字はつけない. 改行は \\n で表現.",
    "",
    "## summary (末尾) について",
    "- 200 字程度 (180〜240 字).",
    `- ${role} 一人称で、 ハイライト + 引っかかり + 明日への一言 を圧縮した総括.`,
    "- 装飾少なめ、 具体的に. 過剰な敬語不要.",
    "",
    "## 入力データ",
    JSON.stringify(
      {
        session: {
          id: session.id,
          provider: session.provider,
          repo_path: session.repo_path,
          repo_origin: session.repo_origin,
          branch: session.branch,
          host: session.host,
          duration_sec: bullets.duration_sec,
          outcome: bullets.outcome,
          status: session.status,
        },
        bullets,
        events_tail: compactEvents,
      },
      null,
      2,
    ).slice(0, 12_000),
  ].join("\n");

  // 日報 narrative も Haiku 固定 (コスト削減方針)。
  const r = await runClaude(prompt, { model: "haiku" });
  if (!r.ok) {
    log.warn({ stderr: r.stderr.slice(0, 200) }, "claude CLI narrative failed");
    return null;
  }

  const json = parsePoemAndSummary(r.stdout);
  if (!json) {
    log.warn({ stdout: r.stdout.slice(0, 200) }, "claude CLI returned unparseable JSON");
    return null;
  }

  // 3 セクションを deterministic に結合: poem + 既存テンプレート + summary
  const middle = templateSummary(session, bullets, usage);
  return [
    json.poem.trim(),
    "",
    "---",
    "",
    middle.trim(),
    "",
    "---",
    "",
    "## サマリ",
    "",
    json.summary.trim(),
  ].join("\n");
}

function parsePoemAndSummary(text: string): { poem: string; summary: string } | null {
  let parsed: any;
  try { parsed = JSON.parse(text.trim()); } catch { /* fall through */ }
  if (!parsed) {
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence) { try { parsed = JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
  }
  if (!parsed) {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { return null; } }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const poem = typeof parsed.poem === "string" ? parsed.poem : null;
  const summary = typeof parsed.summary === "string" ? parsed.summary : null;
  if (!poem || !summary) return null;
  return { poem, summary };
}

function parseMetadata(s: string | null): Record<string, any> {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── helpers ──────────────────────────────────────────

function countTodos(todos: any[]): { completed: number; in_progress: number; pending: number } {
  let completed = 0, in_progress = 0, pending = 0;
  for (const t of todos) {
    const st = (t?.status ?? "").toLowerCase();
    if (st === "completed") completed++;
    else if (st === "in_progress") in_progress++;
    else pending++;
  }
  return { completed, in_progress, pending };
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h${m}m${s}s`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
