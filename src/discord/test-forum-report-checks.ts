/**
 * 登録チェック (Revisor の ci 記録) を人間向けの行へ組み立てる。
 *
 * Revisor 画面のテスト表 (テストケース / 結果 / exit code / 所要 / 備考) と失敗出力に揃える。
 * Revisor は通過したチェックの出力を保持しないため、通過したチェックは名前・結果・exit code・
 * 所要・備考を省かずに並べる。 無い値は「未取得」と書き、推測で補わない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import type { RevisorFailedTest } from "../pr/revisor-test-workflow-client.js";
import { asFields, numberOf, quoteLines, textOf } from "./test-forum-report-content.js";
import { checkResultLabel, formatDuration } from "./test-forum-labels.js";

export interface ReportCheck {
  name: string | null;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  reason: string | null;
  output: { text: string; truncated: boolean } | null;
}

/** Revisor 詳細の checks / failedTests 1 件を表示用へ。 status を持たない failedTests は失敗。 */
export function reportCheckFromResult(
  check: RevisorFailedTest & { status?: string; durationMs?: number | null },
): ReportCheck {
  return {
    name: check.name,
    status: check.status ?? "failed",
    exitCode: check.exitCode,
    durationMs: check.durationMs ?? null,
    reason: check.reason,
    output: check.output,
  };
}

const SETTLED_RESULTS = new Set(["passed", "failed", "skipped"]);

export function reportCheckOf(value: unknown): ReportCheck | null {
  const fields = asFields(value);
  if (!fields) return null;
  const output = asFields(fields.output);
  return {
    name: textOf(fields.name),
    status: textOf(fields.status) ?? "unknown",
    exitCode: numberOf(fields.exitCode),
    durationMs: numberOf(fields.durationMs),
    reason: textOf(fields.reason),
    output: output && typeof output.text === "string"
      ? { text: output.text, truncated: output.truncated === true }
      : null,
  };
}

/** 配列でなければ null (未取得)。 配列の中の読めない要素だけを落とす。 */
export function reportChecksOf(value: unknown): ReportCheck[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const check = reportCheckOf(entry);
    return check ? [check] : [];
  });
}

/** 例: 「3 件通過 / 実行 4 件（スキップ 1 件は含めない）」。 */
export function checkSummary(checks: readonly ReportCheck[]): string {
  const skipped = checks.filter((check) => check.status === "skipped").length;
  const passed = checks.filter((check) => check.status === "passed").length;
  const excluded = skipped > 0 ? `（スキップ ${skipped} 件は含めない）` : "";
  return `${passed} 件通過 / 実行 ${checks.length - skipped} 件${excluded}`;
}

function checkLines(check: ReportCheck): string[] {
  const facts = [checkResultLabel(check.status)];
  if (check.status !== "skipped") {
    facts.push(`exit code ${check.exitCode ?? "未取得"}`);
    const duration = formatDuration(check.durationMs);
    if (duration) facts.push(`所要 ${duration}`);
  }
  const lines = [`- ${check.name ?? "名称未取得"} — ${facts.join(" · ")}`];
  if (check.reason) {
    lines.push(`  ${check.status === "skipped" ? "スキップ理由" : "備考"}: ${check.reason}`);
  }
  if (check.output) {
    lines.push(`  出力${check.output.truncated ? " (末尾のみ・秘匿値はマスク済み)" : " (秘匿値はマスク済み)"}:`);
    lines.push(...quoteLines(check.output.text));
  }
  return lines;
}

/** 通過 / 失敗 / スキップ / 判別不能 に分けて全件を並べる。 */
export function checkSections(checks: readonly ReportCheck[]): string[] {
  if (checks.length === 0) return ["登録チェックの結果はありません。"];
  const groups: ReadonlyArray<readonly [string, (check: ReportCheck) => boolean]> = [
    ["通過したチェック", (check) => check.status === "passed"],
    ["失敗したチェック", (check) => check.status === "failed"],
    ["スキップしたチェック", (check) => check.status === "skipped"],
    ["結果を判別できないチェック", (check) => !SETTLED_RESULTS.has(check.status)],
  ];
  const lines: string[] = [];
  for (const [title, matches] of groups) {
    const members = checks.filter(matches);
    if (members.length === 0) continue;
    lines.push(`${title}:`, ...members.flatMap(checkLines));
  }
  return lines;
}
