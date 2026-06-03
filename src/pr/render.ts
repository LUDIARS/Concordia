/**
 * PR queue markdown renderer.
 */

import type { PrRecordRow } from "../db/pr-records-repo.js";
import type { PrQueueResult } from "./queue.js";

function ciMark(row: PrRecordRow): string {
  switch (row.ci_status) {
    case "success":
      return "✅";
    case "failure":
      return "❌";
    case "pending":
      return "🟡";
    default:
      return "";
  }
}

export interface RenderOptions {
  heading?: string;
  perSection?: number;
  mergedLimit?: number;
  showTimestamp?: boolean;
  mentionFor?: (row: PrRecordRow) => string | null;
  allActiveLimit?: number;
}

function lineOf(row: PrRecordRow, opts: RenderOptions): string {
  const ref = `${row.repo_origin}#${row.number}`;
  const title = (row.title || "(no title)").slice(0, 80);
  const who = row.persona_name ? ` - ${row.persona_name}` : "";
  const ci = ciMark(row);
  const mention = opts.mentionFor?.(row) ?? null;
  const owner = mention ? ` 担当 ${mention}` : "";
  const link = row.url ? ` <${row.url}>` : "";
  return `- \`${ref}\` ${title}${who}${ci ? ` ${ci}` : ""}${owner}${link}`;
}

function section(title: string, rows: PrRecordRow[], limit: number, opts: RenderOptions): string[] {
  if (rows.length === 0) return [];
  const out = [`### ${title} (${rows.length})`];
  for (const r of rows.slice(0, limit)) out.push(lineOf(r, opts));
  if (rows.length > limit) out.push(`- ...残り${rows.length - limit}件`);
  return out;
}

export function renderPrQueueMarkdown(q: PrQueueResult, opts: RenderOptions = {}): string {
  const heading = opts.heading ?? "PR Queue";
  const per = opts.perSection ?? 12;
  const mergedLimit = opts.mergedLimit ?? 5;
  const allActiveLimit = opts.allActiveLimit ?? 20;

  const lines: string[] = [];
  lines.push(`## ${heading}`);
  lines.push(
    `- active ${q.counts.total_active} 件 ` +
      `(マージ可 ${q.counts.ready} / レビュー待ち ${q.counts.needs_review} / 進行中 ${q.counts.in_progress})`,
  );
  if (opts.showTimestamp ?? true) {
    lines.push(`- 更新: <t:${q.generated_at}:R>`);
  }

  if (q.counts.total_active === 0) {
    lines.push("");
    lines.push("_対応待ちの PR はありません_");
  } else {
    lines.push("");
    lines.push(...section("✅ マージ可", q.grouped.ready, per, opts));
    lines.push(...section("🔍 レビュー待ち", q.grouped.needs_review, per, opts));
    lines.push(...section("🛠 進行中", q.grouped.in_progress, per, opts));
  }

  if (q.grouped.merged_recent.length > 0) {
    lines.push("");
    lines.push(...section("🎉 最近マージ", q.grouped.merged_recent, mergedLimit, { ...opts, mentionFor: undefined }));
  }

  if (q.queue.length > 0) {
    lines.push("");
    lines.push(...section("📚 全アクティブPR", q.queue, allActiveLimit, opts));
  }

  return lines.join("\n");
}
