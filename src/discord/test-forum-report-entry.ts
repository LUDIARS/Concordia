/**
 * Revisor 審査履歴の 1 記録を、人間向けの見出しと本文へ組み立てる。
 *
 * レビュー開始は開始した旨、各段階は開始・スキップ理由・結果、最終記録はレビュー内容を
 * 書く。 審査 attempt やコミットの識別子は表示しない (配送の同一性は文書の鍵が持つ)。
 * 対応していない記録形式は内容を推測で並べず、表示できない旨を明記する。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import type { RevisorReviewReport, RevisorReviewReportEntry } from "../pr/revisor-review-report.js";
import { formatReportTime, reportEntryStatusLabel, reviewStageLabel } from "./test-forum-labels.js";
import {
  asFields,
  maskedContentNotice,
  readEntryContent,
  section,
  textOf,
  UNREADABLE_CONTENT_NOTICE,
  UNSUPPORTED_CONTENT_NOTICE,
  type EntryContent,
} from "./test-forum-report-content.js";
import {
  anatomiaStageBlocks,
  finalOutcomeBlocks,
  reviewStageBlocks,
  securityStageBlocks,
  testsStageBlocks,
} from "./test-forum-report-stage.js";

export interface RenderedReportEntry {
  title: string;
  text: string;
}

interface EntryBody {
  title: string;
  blocks: string[];
}

const STARTED_TEXT = "審査を開始しました。各段階の開始と結果をこのスレッドへ記録します。";

/** Revisor が記録する定型文 (local-reporter.mjs)。 */
const START_MESSAGES: Readonly<Record<string, EntryBody>> = {
  "Review queued.": {
    title: "審査待ち",
    blocks: ["審査の順番待ちに登録しました。開始すると、各段階の開始と結果をこのスレッドへ記録します。"],
  },
  "Review worker started.": { title: "レビュー開始", blocks: [STARTED_TEXT] },
  "Review started.": { title: "レビュー開始", blocks: [STARTED_TEXT] },
};

const STAGE_NOTES: Readonly<Record<string, string>> = {
  "Check started.": "この段階を開始しました。結果はこのスレッドへ記録します。",
  "Reused from an equivalent completed review stage.":
    "同じ内容で完了済みの審査段階の結果を引き継いだため、この段階は実行していません。",
};

/** 段階の完了記録 (Revisor reviewReportEntry) として保存される形式ごとの文章化。 */
function stageBlocks(stage: string, value: unknown): string[] {
  switch (stage) {
    case "tests":
      return testsStageBlocks(value);
    case "anatomia":
      return anatomiaStageBlocks(value);
    case "security":
      return securityStageBlocks(value);
    case "review":
      return reviewStageBlocks(value);
    default:
      return [UNSUPPORTED_CONTENT_NOTICE];
  }
}

/** 文章として記録される内容。 構造化データが来た場合は未対応の形式として扱う。 */
function textBlocks(content: EntryContent): string[] {
  switch (content.kind) {
    case "text":
      return [content.text];
    case "masked":
      return [maskedContentNotice(content.rules)];
    case "unreadable":
      return [UNREADABLE_CONTENT_NOTICE];
    case "structured":
      return [UNSUPPORTED_CONTENT_NOTICE];
  }
}

function startEntry(content: EntryContent): EntryBody {
  const known = content.kind === "text" ? START_MESSAGES[content.text.trim()] : undefined;
  return known ?? { title: "レビュー開始", blocks: ["審査を開始しました。", ...textBlocks(content)] };
}

function stageEntry(stage: string, entry: RevisorReviewReportEntry, content: EntryContent): EntryBody {
  const title = `${reviewStageLabel(stage)} — ${reportEntryStatusLabel(entry.status)}`;
  if (content.kind === "structured") return { title, blocks: stageBlocks(stage, content.value) };
  if (content.kind !== "text") return { title, blocks: textBlocks(content) };
  const note = STAGE_NOTES[content.text.trim()] ?? content.text;
  return { title, blocks: [entry.status === "skipped" ? `スキップ理由: ${note}` : note] };
}

/** 同じ attempt のモデルレビュー段階が同一本文を全文掲載していれば、その見出しを返す。 */
function reviewTextPostedAs(finalValue: unknown, report: RevisorReviewReport): string | null {
  const finalText = textOf(asFields(finalValue)?.reviewerOutput);
  if (!finalText) return null;
  const stage = report.entries.find((entry) => entry.id === "stage:review" && entry.status === "passed");
  if (!stage) return null;
  const content = readEntryContent(stage.content);
  if (content.kind !== "structured" || textOf(asFields(content.value)?.reviewerOutput) !== finalText) return null;
  return `${reviewStageLabel("review")} — ${reportEntryStatusLabel(stage.status)}`;
}

function finalEntry(entry: RevisorReviewReportEntry, content: EntryContent, report: RevisorReviewReport): EntryBody {
  if (entry.status === "failed") {
    return { title: "審査失敗", blocks: ["審査の実行に失敗しました。", section("エラー", textBlocks(content))] };
  }
  const verdict = entry.status === "passed"
    ? "通過"
    : entry.status === "action_required" ? "人間の対応が必要" : reportEntryStatusLabel(entry.status);
  const title = `レビュー完了 — ${verdict}`;
  if (content.kind !== "structured") return { title, blocks: textBlocks(content) };
  return {
    title,
    blocks: finalOutcomeBlocks(content.value, { reviewTextPostedAs: reviewTextPostedAs(content.value, report) }),
  };
}

export function renderReportEntry(
  entry: RevisorReviewReportEntry,
  report: RevisorReviewReport,
): RenderedReportEntry {
  const content = readEntryContent(entry.content);
  let body: EntryBody;
  if (entry.id === "review-start") {
    body = startEntry(content);
  } else if (entry.id === "final") {
    body = finalEntry(entry, content, report);
  } else if (entry.id.startsWith("stage:")) {
    body = stageEntry(entry.id.slice("stage:".length), entry, content);
  } else {
    body = {
      title: `${entry.label.trim() || "審査記録"} — ${reportEntryStatusLabel(entry.status)}`,
      blocks: content.kind === "text" || content.kind === "masked" ? textBlocks(content) : [UNSUPPORTED_CONTENT_NOTICE],
    };
  }
  return { title: body.title, text: [`日時: ${formatReportTime(entry.at)}`, ...body.blocks].join("\n\n") };
}
