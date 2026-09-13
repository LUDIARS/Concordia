/**
 * 旧形式の受領印 (Bot 投稿の footer「Revisor report • 鍵」) で配送済みの文書を識別する鍵。
 *
 * 2026-09-12 版は文書の表示本文から鍵を作り、footer に表示していた。 表示を人間向けに
 * 変えると新しい鍵は旧受領印と一致しないため、掲載中のスレッドへ同じ審査結果を再送しない
 * よう、旧版と同じ式で鍵だけを再計算する。 ここで組む本文は表示に使わない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import { createHash } from "node:crypto";
import type { RevisorReviewReportEntry } from "../pr/revisor-review-report.js";
import type { RevisorCheckResult, RevisorFailedTest } from "../pr/revisor-test-workflow-client.js";
import { redactSecrets } from "../shared/redact-secrets.js";
import type { TestForumCandidate } from "./test-forum-reconcile.js";
import { splitReviewText } from "./test-forum-report-split.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityOf(candidate: TestForumCandidate): string {
  return `${candidate.repoOrigin}#${candidate.prNumber}`;
}

export function legacyAttemptOf(candidate: TestForumCandidate): string {
  return candidate.detail?.reviewReport?.attemptId ?? candidate.headSha;
}

/** 旧 reportMessages と同じく、分割片ごとの受領鍵を返す。 */
function legacyMessageKeys(candidate: TestForumCandidate, id: string, title: string, text: string): string[] {
  const cleanTitle = redactSecrets(title);
  const cleanText = redactSecrets(text);
  const documentKey = sha256(JSON.stringify([identityOf(candidate), id, cleanTitle, cleanText]));
  return splitReviewText(cleanText).map((_, index) => sha256(`${documentKey}:${index}`));
}

export function legacyBodyKeys(candidate: TestForumCandidate): string[] {
  const detail = candidate.detail;
  return legacyMessageKeys(candidate, `body:${candidate.headSha}`, "PR 本文", [
    `${identityOf(candidate)}: ${candidate.title}`,
    `${candidate.headBranch} → ${detail?.baseRef ?? "不明"}`,
    `コミット: ${candidate.headSha}`,
    detail?.body ?? "PR 本文は未取得または未記入です。",
  ].join("\n\n"));
}

export function legacyEntryKeys(
  candidate: TestForumCandidate,
  entry: RevisorReviewReportEntry,
  reportHeadSha: string,
): string[] {
  const attempt = legacyAttemptOf(candidate);
  return legacyMessageKeys(candidate, `${attempt}:${entry.id}`, `${entry.label} — ${entry.status}`, [
    `日時: ${entry.at}`,
    `審査: ${attempt} / コミット: ${reportHeadSha}`,
    entry.content,
  ].join("\n\n"));
}

export function legacyNoHistoryKeys(candidate: TestForumCandidate): string[] {
  return legacyMessageKeys(
    candidate,
    `legacy:${legacyAttemptOf(candidate)}`,
    "審査履歴の取得状況",
    "この Revisor は詳細な実行履歴を返していません。以下は取得できた現在の結果です。開始時刻や未取得の結果を推測して補いません。",
  );
}

export function legacyCheckKeys(
  candidate: TestForumCandidate,
  check: RevisorCheckResult | RevisorFailedTest,
  index: number,
): string[] {
  return legacyMessageKeys(candidate, `check:${legacyAttemptOf(candidate)}:${index}`, `チェック: ${check.name}`, [
    `状態: ${"status" in check ? check.status : "failed"}`,
    `終了コード: ${check.exitCode ?? "未取得"}`,
    check.reason ? `理由: ${check.reason}` : "",
    check.output?.truncated ? "出力は Revisor 側で省略されています。以下は保持されている全文です。" : "",
    check.output?.text ?? "出力なし／未取得",
  ].filter(Boolean).join("\n\n"));
}

export function legacyDecisionKeys(candidate: TestForumCandidate): string[] {
  const detail = candidate.detail;
  return legacyMessageKeys(candidate, `decision:${legacyAttemptOf(candidate)}`, "審査結果・判断事項", [
    `状態: ${candidate.checkStatus}`,
    `判定: ${detail?.decisionLabel ?? "未取得"}`,
    `セキュリティ: ${detail?.securityStatus ?? "未取得"}`,
    `登録チェック: ${detail?.testsPassed ?? "?"}/${detail?.testsRan ?? "?"} passed（スキップを除く）`,
    ...(detail?.blockers ?? []).map((reason) => `- ${reason}`),
    detail?.reviewError ?? "",
    detail?.autoMerge ? `マージ: ${detail.autoMerge.merged ? "済み" : "見送り"} — ${detail.autoMerge.reason}` : "",
  ].filter(Boolean).join("\n"));
}
