/**
 * Human-facing review documents. Long sections are retained, not silently clipped.
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import { createHash } from "node:crypto";
import type { TestForumCandidate } from "./test-forum-reconcile.js";
import { redactSecrets } from "../shared/redact-secrets.js";

export interface ReviewDocument {
  key: string;
  title: string;
  text: string;
}

export function reviewDocuments(candidate: TestForumCandidate): ReviewDocument[] {
  const detail = candidate.detail;
  const report = detail?.reviewReport;
  const identity = `${candidate.repoOrigin}#${candidate.prNumber}`;
  const attempt = report?.attemptId ?? candidate.headSha;
  const documents: ReviewDocument[] = [];
  const add = (id: string, title: string, text: string): void => {
    const cleanTitle = redactSecrets(title);
    const cleanText = redactSecrets(text);
    const key = createHash("sha256").update(JSON.stringify([identity, id, cleanTitle, cleanText])).digest("hex");
    documents.push({ key, title: cleanTitle, text: cleanText });
  };
  add(`body:${candidate.headSha}`, "PR 本文", [
    `${identity}: ${candidate.title}`,
    `${candidate.headBranch} → ${detail?.baseRef ?? "不明"}`,
    `コミット: ${candidate.headSha}`,
    detail?.body ?? "PR 本文は未取得または未記入です。",
  ].join("\n\n"));
  if (report) {
    for (const entry of report.entries) {
      add(`${attempt}:${entry.id}`, `${entry.label} — ${entry.status}`, [
        `日時: ${entry.at}`,
        `審査: ${attempt} / コミット: ${report.headSha}`,
        entry.content,
      ].join("\n\n"));
    }
  } else {
    add(`legacy:${attempt}`, "審査履歴の取得状況", "この Revisor は詳細な実行履歴を返していません。以下は取得できた現在の結果です。開始時刻や未取得の結果を推測して補いません。");
    for (const [index, check] of (detail?.checks ?? detail?.failedTests ?? []).entries()) {
      add(`check:${attempt}:${index}`, `チェック: ${check.name}`, [
        `状態: ${"status" in check ? check.status : "failed"}`,
        `終了コード: ${check.exitCode ?? "未取得"}`,
        check.reason ? `理由: ${check.reason}` : "",
        check.output?.truncated ? "出力は Revisor 側で省略されています。以下は保持されている全文です。" : "",
        check.output?.text ?? "出力なし／未取得",
      ].filter(Boolean).join("\n\n"));
    }
  }
  add(`decision:${attempt}`, "審査結果・判断事項", [
    `状態: ${candidate.checkStatus}`,
    `判定: ${detail?.decisionLabel ?? "未取得"}`,
    `セキュリティ: ${detail?.securityStatus ?? "未取得"}`,
    `登録チェック: ${detail?.testsPassed ?? "?"}/${detail?.testsRan ?? "?"} passed（スキップを除く）`,
    ...(detail?.blockers ?? []).map((reason) => `- ${reason}`),
    detail?.reviewError ?? "",
    detail?.autoMerge ? `マージ: ${detail.autoMerge.merged ? "済み" : "見送り"} — ${detail.autoMerge.reason}` : "",
  ].filter(Boolean).join("\n"));
  return documents;
}

/** Each UTF-8 attachment remains comfortably below Discord's normal upload limit. */
export function splitReviewText(text: string, limit = 500_000): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError("Review text limit must be at least 2");
  const result: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(text.slice(start, end));
    start = end;
  }
  return result.length ? result : [""];
}
