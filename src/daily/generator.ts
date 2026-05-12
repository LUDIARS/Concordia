/**
 * 1 日分の日報を生成する.
 *
 * 1. aggregateDay で bullets を作る
 * 2. claude CLI で narrative summary を生成
 *    (CONCORDIA_DISABLE_CLAUDE=1 なら template fallback)
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DayReportRow } from "../db/day-reports-repo.js";
import { aggregateDay, dayRange, type DayBullets } from "./aggregator.js";
import { runClaude } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("daily-report");

export async function generateDayReport(
  date_iso: string,
  sessionsRepo: SessionsRepo,
): Promise<DayReportRow> {
  const date = parseISODate(date_iso);
  const range = dayRange(date);
  const sessions = sessionsRepo.listSessionsInRange(range.startTs, range.endTs);
  const bullets = aggregateDay(date_iso, sessions, sessionsRepo);

  let summary_md: string | null = null;
  if (process.env.CONCORDIA_DISABLE_CLAUDE !== "1") {
    summary_md = await narrativeViaCli(bullets);
  }
  if (!summary_md) {
    summary_md = templateSummary(bullets);
  }

  return {
    date_iso,
    generated_at: Math.floor(Date.now() / 1000),
    summary_md,
    bullets: JSON.stringify(bullets),
    session_count: bullets.session_count,
    total_duration_sec: bullets.total_duration_sec,
    metadata: null,
  };
}

async function narrativeViaCli(b: DayBullets): Promise<string | null> {
  if (b.session_count === 0) {
    return `${b.date_iso} は active な session がありませんでした。`;
  }
  const prompt = [
    `Concordia の本日 (${b.date_iso}) のセッション群を統合して 1 日の日報を書いてください。`,
    "出力は markdown で 3-4 段落. 装飾的な見出し h1 は不要、 本文だけ.",
    "",
    "## 含める要素",
    "- 全体感: どんな 1 日だったか (作業量 / 雰囲気 / role 構成)",
    "- ハイライト (今日うまくいったこと、 ファイル / branch / 機能で何が動いたか)",
    "- 引っかかったこと / lost セッション / 解決待ち",
    "- 明日への手筋 / 引継ぎメモ",
    "",
    "## トーン",
    "- AI 同士の対話前提なので人間配慮不要",
    "- 過剰な敬語不要、 簡潔で具体的に",
    "- 数字 (session_count / files 数 / duration) は具体的に引用",
    "",
    "## 入力データ",
    JSON.stringify(b, null, 2).slice(0, 12_000),
  ].join("\n");

  const r = await runClaude(prompt);
  if (!r.ok) {
    log.warn({ stderr: r.stderr.slice(0, 200) }, "claude CLI day-report failed");
    return null;
  }
  const text = r.stdout.trim();
  if (!text || text.length < 30) return null;
  return text;
}

function templateSummary(b: DayBullets): string {
  const lines: string[] = [];
  lines.push(`# ${b.date_iso} の日報 (template fallback)`);
  lines.push("");
  lines.push(`- session: ${b.session_count} 件`);
  lines.push(`- 合計時間: ${formatDuration(b.total_duration_sec)}`);
  lines.push(`- outcome: ended=${b.outcomes.ended} / lost=${b.outcomes.lost} / abandoned=${b.outcomes.abandoned} / active=${b.outcomes.active}`);
  if (b.repos.length) lines.push(`- repos: ${b.repos.join(", ")}`);
  if (b.branches.length) lines.push(`- branches: ${b.branches.join(", ")}`);
  if (b.files.edited.length || b.files.created.length || b.files.deleted.length) {
    lines.push(`- files: edited=${b.files.edited.length} created=${b.files.created.length} deleted=${b.files.deleted.length}`);
  }
  if (Object.keys(b.events).length) {
    lines.push(`- events: ${Object.entries(b.events).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (Object.keys(b.roles).length) {
    lines.push(`- roles: ${Object.entries(b.roles).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  return lines.join("\n");
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h${m}m${s}s`;
}

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
