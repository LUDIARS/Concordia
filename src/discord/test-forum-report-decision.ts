/**
 * 「審査結果・判断事項」の文書。
 *
 * Revisor 画面の判定欄 (decisionOf / factorsOf / runtimeOf) とテスト表に揃え、マージリスクの
 * 内訳と、通過したものを含む登録チェックの名前・内容を省かずに並べる。 Revisor から
 * 取得できなかった項目は「未取得」と書き、通過や加点なしとして補わない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import type { RevisorLocalPrDetail, RevisorRiskFactor } from "../pr/revisor-test-workflow-client.js";
import type { TestForumCandidate } from "./test-forum-reconcile.js";
import { checkStatusLabel, securityStatusLabel } from "./test-forum-labels.js";
import { bulletLines, section } from "./test-forum-report-content.js";
import { checkSections, checkSummary, reportCheckFromResult } from "./test-forum-report-checks.js";

function factorLine(factor: RevisorRiskFactor): string {
  return `${factor.points > 0 ? "+" : ""}${factor.points} ${factor.detail}`;
}

function riskBlock(detail: RevisorLocalPrDetail): string {
  const score = detail.riskScore === null
    ? "未算定"
    : `${detail.riskScore} / 100${detail.riskBandLabel ? ` (${detail.riskBandLabel})` : ""}`
      + (detail.riskThreshold !== null ? ` · 閾値 ${detail.riskThreshold}` : "");
  const factors = detail.mergeRiskFactors;
  let breakdown: string[];
  if (factors) breakdown = bulletLines(factors.map((factor) => factorLine(factor)), "加点要因はありません。");
  else if (detail.riskScore === null) breakdown = ["マージリスクは算定されていません。"];
  else breakdown = ["内訳は Revisor から取得できませんでした。"];
  return section("マージリスク", [score, "内訳:", ...breakdown]);
}

function runtimeBlock(detail: RevisorLocalPrDetail): string {
  const runtime = detail.runtimeVerification;
  if (!runtime) return section("動作確認の必要性", ["動作確認の判定はまだありません。"]);
  return section("動作確認の必要性", [
    `判定: ${runtime.required ? "人間による動作確認が必要" : "登録テストで足りる"}`,
    `スコア: ${runtime.score ?? "未算定"} / 100`,
    `動作テストの通過: ${runtime.evidence.join(", ") || "—"}`,
    "内訳:",
    ...bulletLines(runtime.factors.map((factor) => factorLine(factor)), "加点要因はありません。"),
  ]);
}

function checksBlock(detail: RevisorLocalPrDetail): string {
  const checks = (detail.checks ?? detail.failedTests).map(reportCheckFromResult);
  if (detail.testsRan === null && checks.length === 0) {
    return section("登録チェック", ["登録チェックの結果は未取得です。"]);
  }
  return section(`登録チェック: ${checkSummary(checks)}`, checkSections(checks));
}

function blockersBlock(detail: RevisorLocalPrDetail): string {
  const failed = detail.decisionState === "failed";
  return section(
    failed ? "審査失敗の理由" : "人間の判断が必要な理由",
    bulletLines(detail.blockers, failed ? "審査失敗の理由は記録されていません。" : "判断待ちの理由はありません。"),
  );
}

export function decisionReportText(candidate: TestForumCandidate): string {
  const detail = candidate.detail;
  const status = `状態: ${checkStatusLabel(candidate.checkStatus, detail)}`;
  if (!detail) {
    return [status, "Revisor の詳細を取得できませんでした。判定・マージリスク・登録チェックの結果は未取得です。"].join("\n\n");
  }
  const summary = [
    status,
    `判定: ${detail.decisionLabel ?? "未取得"}`,
    `マージ可否: ${detail.mergeable ? "マージOK" : "保留"}`,
    `セキュリティスキャン: ${detail.securityStatus ? securityStatusLabel(detail.securityStatus) : "未取得"}`,
    ...(detail.autoMerge
      ? [`自動マージ結果: ${detail.autoMerge.merged ? "マージ済み" : "見送り"} — ${detail.autoMerge.reason || "理由は記録されていません"}`]
      : []),
  ];
  return [
    summary.join("\n"),
    riskBlock(detail),
    runtimeBlock(detail),
    checksBlock(detail),
    blockersBlock(detail),
    ...(detail.reviewError ? [section("審査エラー", [detail.reviewError])] : []),
  ].join("\n\n");
}
