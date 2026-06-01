/**
 * PR キューの Markdown レンダラ.
 *
 * API の /v1/prs/digest と Discord の pr-queue チャンネル / `/prs` コマンドが
 * これを共有する (表示一貫性). Discord 1 メッセージ上限を考慮し、 呼び出し側で
 * slice(0, 3900) する前提のコンパクトな出力にする.
 */

import type { PrRecordRow } from "../db/pr-records-repo.js";
import type { PrQueueResult } from "./queue.js";

function ciMark(row: PrRecordRow): string {
  switch (row.ci_status) {
    case "success":
      return "🟢";
    case "failure":
      return "🔴";
    case "pending":
      return "🟡";
    default:
      return "";
  }
}

/** 1 PR を 1 行に. 例: `LUDIARS/Concordia#77 Fix … — 火盛 渋 🟢` */
function lineOf(row: PrRecordRow): string {
  const ref = `${row.repo_origin}#${row.number}`;
  const title = (row.title || "(no title)").slice(0, 80);
  const who = row.persona_name ? ` — ${row.persona_name}` : "";
  const ci = ciMark(row);
  const link = row.url ? ` <${row.url}>` : "";
  return `- \`${ref}\` ${title}${who}${ci ? ` ${ci}` : ""}${link}`;
}

function section(title: string, rows: PrRecordRow[], limit: number): string[] {
  if (rows.length === 0) return [];
  const out = [`### ${title} (${rows.length})`];
  for (const r of rows.slice(0, limit)) out.push(lineOf(r));
  if (rows.length > limit) out.push(`- …他 ${rows.length - limit} 件`);
  return out;
}

export interface RenderOptions {
  /** 見出し (既定 "PR Queue"). */
  heading?: string;
  /** 各セクションの最大行数 (既定 12). */
  perSection?: number;
  /** 最近マージの最大行数 (既定 5). */
  mergedLimit?: number;
  /** 末尾に更新時刻を出すか (既定 true). */
  showTimestamp?: boolean;
}

export function renderPrQueueMarkdown(q: PrQueueResult, opts: RenderOptions = {}): string {
  const heading = opts.heading ?? "PR Queue";
  const per = opts.perSection ?? 12;
  const mergedLimit = opts.mergedLimit ?? 5;

  const lines: string[] = [];
  lines.push(`## ${heading}`);
  lines.push(
    `- active ${q.counts.total_active} 件 ` +
      `(✅マージ可 ${q.counts.ready} / 🔍レビュー待ち ${q.counts.needs_review} / 🛠進行中 ${q.counts.in_progress})`,
  );
  if (opts.showTimestamp ?? true) {
    lines.push(`- 更新: <t:${q.generated_at}:R>`);
  }

  if (q.counts.total_active === 0) {
    lines.push("");
    lines.push("_対応待ちの PR はありません_");
  } else {
    lines.push("");
    lines.push(...section("✅ マージ可", q.grouped.ready, per));
    lines.push(...section("🔍 レビュー待ち", q.grouped.needs_review, per));
    lines.push(...section("🛠 進行中", q.grouped.in_progress, per));
  }
  if (q.grouped.merged_recent.length > 0) {
    lines.push("");
    lines.push(...section("🟣 最近マージ", q.grouped.merged_recent, mergedLimit));
  }
  return lines.join("\n");
}
