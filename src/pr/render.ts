/**
 * PR キューの Markdown レンダラ.
 *
 * API の /v1/prs/digest と Discord の pr-queue チャンネル / `/prs` コマンドが
 * これを共有する (表示一貫性). Discord 1 メッセージ上限を考慮し、 呼び出し側で
 * slice(0, 3900) する前提のコンパクトな出力にする.
 *
 * Discord 固有の「担当セッションのチャンネルリンク」 は `mentionFor` で注入する
 * (API / MCP では渡さない — `<#id>` 形式の mention は Discord でしか解決されない).
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

export interface RenderOptions {
  /** 見出し (既定 "PR Queue"). */
  heading?: string;
  /** 各セクションの最大行数 (既定 12). */
  perSection?: number;
  /** 最近マージの最大行数 (既定 5). */
  mergedLimit?: number;
  /** 末尾に更新時刻を出すか (既定 true). */
  showTimestamp?: boolean;
  /**
   * 担当セッションの「リンク表現」 を返す任意リゾルバ. Discord では author の
   * session channel を `<#channelId>` (クリック可能なチャンネルリンク) に解決して
   * 返す. null を返すと担当表記を省く (channel 未割当 / 終了済セッション等).
   */
  mentionFor?: (row: PrRecordRow) => string | null;
}

/** 1 PR を 1 行に. 例: `LUDIARS/Concordia#77 Fix … — 火盛 渋 🟢 担当 #s-1234 <url>` */
function lineOf(row: PrRecordRow, opts: RenderOptions): string {
  const ref = `${row.repo_origin}#${row.number}`;
  const title = (row.title || "(no title)").slice(0, 80);
  const who = row.persona_name ? ` — ${row.persona_name}` : "";
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
  if (rows.length > limit) out.push(`- …他 ${rows.length - limit} 件`);
  return out;
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
    lines.push(...section("✅ マージ可", q.grouped.ready, per, opts));
    lines.push(...section("🔍 レビュー待ち", q.grouped.needs_review, per, opts));
    lines.push(...section("🛠 進行中", q.grouped.in_progress, per, opts));
  }
  if (q.grouped.merged_recent.length > 0) {
    lines.push("");
    // 最近マージは履歴 (担当 channel は終了済で消えていることが多い) なので mention は付けない.
    lines.push(...section("🟣 最近マージ", q.grouped.merged_recent, mergedLimit, { ...opts, mentionFor: undefined }));
  }
  return lines.join("\n");
}
