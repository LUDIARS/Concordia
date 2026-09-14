/**
 * Human-facing review documents. Long sections are retained, not silently clipped.
 *
 * 表示本文には審査 attempt・コミット・配送鍵を載せない。 文書の同一性は内部の key が持ち、
 * 表示文言ではなく元データから作るので、文言を改善しても配送済みの内容を再送しない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import { createHash } from "node:crypto";
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import type { TestForumCandidate } from "./test-forum-reconcile.js";
import { redactSecrets } from "../shared/redact-secrets.js";
import { checkSections, reportCheckFromResult } from "./test-forum-report-checks.js";
import { decisionReportText } from "./test-forum-report-decision.js";
import { renderReportEntry } from "./test-forum-report-entry.js";
import {
  legacyAttemptOf,
  legacyBodyKeys,
  legacyCheckKeys,
  legacyDecisionKeys,
  legacyEntryKeys,
  legacyNoHistoryKeys,
} from "./test-forum-report-legacy-keys.js";

export { splitReviewText } from "./test-forum-report-split.js";

export interface ReviewDocument {
  /** 配送の同一性 (内部のみ)。 */
  key: string;
  /** 旧版の footer 受領印の鍵。 全て受領済みなら配送済みとして扱う。 */
  legacyMessageKeys: readonly string[];
  title: string;
  text: string;
  /** 添付テキストのファイル名 (拡張子なし、ASCII)。 */
  fileStem: string;
}

const DOCUMENT_KEY_VERSION = "review-document/v2";

function fileSlug(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "entry";
}

/** 判定欄に描く値だけを指紋に使う。 履歴の進行だけで判断事項を再掲しない。 */
function decisionSource(detail: RevisorLocalPrDetail | null): unknown {
  if (!detail) return null;
  return {
    decisionState: detail.decisionState,
    decisionLabel: detail.decisionLabel,
    mergeable: detail.mergeable,
    riskScore: detail.riskScore,
    riskThreshold: detail.riskThreshold,
    riskBandLabel: detail.riskBandLabel,
    mergeRiskFactors: detail.mergeRiskFactors ?? null,
    runtimeVerification: detail.runtimeVerification ?? null,
    securityStatus: detail.securityStatus,
    testsRan: detail.testsRan,
    checks: detail.checks ?? detail.failedTests,
    blockers: detail.blockers,
    reviewError: detail.reviewError,
    autoMerge: detail.autoMerge,
  };
}

export function reviewDocuments(candidate: TestForumCandidate): ReviewDocument[] {
  const detail = candidate.detail;
  const report = detail?.reviewReport;
  const identity = `${candidate.repoOrigin}#${candidate.prNumber}`;
  const attempt = legacyAttemptOf(candidate);
  const documents: ReviewDocument[] = [];
  const add = (
    source: readonly unknown[],
    document: { title: string; text: string; fileStem: string; legacyMessageKeys: readonly string[] },
  ): void => {
    const key = createHash("sha256")
      .update(JSON.stringify([DOCUMENT_KEY_VERSION, identity, ...source]))
      .digest("hex");
    documents.push({
      ...document,
      key,
      title: redactSecrets(document.title),
      text: redactSecrets(document.text),
    });
  };
  add(["body", candidate.title, candidate.headBranch, detail?.baseRef ?? null, detail?.body ?? null], {
    title: "PR 本文",
    text: [
      `${identity}: ${candidate.title}`,
      `${candidate.headBranch} → ${detail?.baseRef ?? "不明"}`,
      detail?.body ?? "PR 本文は未取得または未記入です。",
    ].join("\n\n"),
    fileStem: "pr-body",
    legacyMessageKeys: legacyBodyKeys(candidate),
  });
  if (report) {
    for (const entry of report.entries) {
      const rendered = renderReportEntry(entry, report);
      add(["entry", attempt, entry.id, entry.kind, entry.label, entry.status, entry.at, entry.content], {
        ...rendered,
        fileStem: `review-${fileSlug(entry.id)}`,
        legacyMessageKeys: legacyEntryKeys(candidate, entry, report.headSha),
      });
    }
  } else {
    add(["no-history", attempt], {
      title: "審査履歴の取得状況",
      text: "この Revisor は詳細な実行履歴を返していません。以下は取得できた現在の結果です。開始時刻や未取得の結果を推測して補いません。",
      fileStem: "review-history",
      legacyMessageKeys: legacyNoHistoryKeys(candidate),
    });
    for (const [index, check] of (detail?.checks ?? detail?.failedTests ?? []).entries()) {
      add(["check", attempt, index, check], {
        title: `チェック: ${check.name}`,
        text: checkSections([reportCheckFromResult(check)]).join("\n"),
        fileStem: `check-${index + 1}`,
        legacyMessageKeys: legacyCheckKeys(candidate, check, index),
      });
    }
  }
  add(["decision", attempt, candidate.checkStatus, decisionSource(detail)], {
    title: "審査結果・判断事項",
    text: decisionReportText(candidate),
    fileStem: "review-decision",
    legacyMessageKeys: legacyDecisionKeys(candidate),
  });
  return documents;
}
