/**
 * セッション終了レポート生成.
 *
 * - bullets: 構造化集計 (events count / files / todos / outcome)
 * - summary_md: claude CLI で narrative 生成 → fallback で Anthropic API → fallback で template
 *
 * spec/service-schema.md §7 準拠.
 */

import type { SessionEventRow, SessionReportRow, SessionRow } from "../shared/types.js";
import { runClaude } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";

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

export function templateSummary(session: SessionRow, b: ReportBullets): string {
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
  return lines.join("\n");
}

/**
 * LLM (Anthropic API) で要約. 失敗時は template fallback.
 * v0.1 では fetch で直叩き (SDK に依存しない). 詳細は v0.2 で claude-api skill 流用.
 */
export async function llmSummary(
  session: SessionRow,
  events: SessionEventRow[],
  cfg: { apiKey: string; model: string },
): Promise<string | null> {
  if (!cfg.apiKey) return null;
  const compact = events
    .filter((e) => ["prompt", "edit", "compact", "task_update", "lost"].includes(e.kind))
    .map((e) => ({ kind: e.kind, ts: e.ts, payload: safeParse(e.payload) }));

  const promptText =
    `You are summarizing an AI coding session. Output a concise markdown report (Japanese).\n` +
    `provider=${session.provider} repo=${session.repo_origin} branch=${session.branch ?? ""}\n` +
    `events:\n${JSON.stringify(compact).slice(0, 8000)}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 800,
        messages: [{ role: "user", content: promptText }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

export async function generateReport(
  session: SessionRow,
  events: SessionEventRow[],
  llm: { apiKey: string; model: string },
): Promise<SessionReportRow> {
  const bullets = aggregateBullets(session, events);

  // 優先 1: claude CLI で narrative
  let summary_md: string | null = await narrativeViaCli(session, events, bullets);

  // 優先 2: Anthropic API (legacy path)
  if (!summary_md) {
    summary_md = await llmSummary(session, events, llm);
  }

  // 最終 fallback: template (3 セクション構造を保つため poem / summary placeholder を被せる)
  if (!summary_md) {
    summary_md = fallbackThreeSection(session, bullets);
  }

  return {
    session_id: session.id,
    generated_at: nowSec(),
    summary_md,
    bullets: JSON.stringify(bullets),
    duration_sec: bullets.duration_sec,
    metadata: null,
  };
}

/**
 * AI narrative が両方失敗したときの fallback. poem / summary は出せないので
 * 「生成できなかった」 と明記した placeholder を入れて 3 セクション構造だけ保つ.
 * extractMonologue が `\n---` 前で切るので poem セクションは独白として #報告 channel に流れる.
 */
function fallbackThreeSection(session: SessionRow, bullets: ReportBullets): string {
  const role = parseMetadata(session.metadata).role_label ?? "雑用係";
  const dur = formatDuration(bullets.duration_sec);
  const poemPlaceholder = [
    `(${role} は今回ポエムを綴れなかった — AI narrative 生成失敗)`,
    `${dur} の作業ログ. ${bullets.outcome}.`,
  ].join("\n");
  const summaryPlaceholder =
    "narrative 生成が両系統 (claude CLI / Anthropic API) とも失敗したため、 構造化集計のみ.";
  const middle = templateSummary(session, bullets);
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
  const middle = templateSummary(session, bullets);
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
