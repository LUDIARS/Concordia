/**
 * 審査段階と最終結果の構造化記録を人間向けの文章へ組み立てる。
 *
 * 見出しと語は Revisor 画面 (reviewOf / planOf / analysisOf / testsOf) に揃える。
 * 機械キーを並べ替えただけの表示や JSON の貼り付けにはしない。 記録に無い値は
 * 「未取得」「記録されていません」と書き、通過や空として補わない。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import {
  asFields,
  bulletLines,
  hasField,
  listOf,
  numberOf,
  section,
  stringsOf,
  textOf,
  type Fields,
} from "./test-forum-report-content.js";
import { checkSections, checkSummary, reportChecksOf } from "./test-forum-report-checks.js";
import { reviewStageLabel, securityStatusLabel } from "./test-forum-labels.js";

/** 読み取れなかった項目を行に含めない。 */
function optionalLine(line: string | null): string[] {
  return line === null ? [] : [line];
}

function locationOf(fields: Fields): string {
  const file = textOf(fields.file) ?? textOf(fields.path);
  if (!file) return "";
  const line = numberOf(fields.line);
  return `  ${file}${line === null ? "" : `:${line}`}`;
}

export function reviewerLabel(value: unknown): string {
  const reviewer = textOf(value);
  if (!reviewer) return "未実施";
  return reviewer === "skipped" ? "スキップ (モデルレビューを実施していません)" : reviewer;
}

export function testsStageBlocks(value: unknown): string[] {
  const checks = reportChecksOf(value);
  if (!checks) return ["登録テストの結果を読み取れませんでした。"];
  return [section(`登録テスト: ${checkSummary(checks)}`, checkSections(checks))];
}

function violationLine(value: unknown): string | null {
  const fields = asFields(value);
  if (!fields) return textOf(value);
  const message = textOf(fields.message) ?? textOf(fields.rule);
  if (!message) return null;
  const severity = textOf(fields.severity);
  return `${severity ? `[${severity}] ` : ""}${message}${locationOf(fields)}`;
}

function functionLine(value: unknown): string | null {
  const fields = asFields(value);
  if (!fields) return textOf(value);
  const name = textOf(fields.name) ?? textOf(fields.qualifiedName) ?? textOf(fields.id);
  return name ? `${name}${locationOf(fields)}` : null;
}

function gateLine(value: unknown): string | null {
  const fields = asFields(value);
  if (!fields) return textOf(value);
  const name = textOf(fields.name) ?? textOf(fields.id) ?? textOf(fields.gate);
  const verdict = typeof fields.pass === "boolean" ? (fields.pass ? "通過" : "不合格") : textOf(fields.status);
  const message = textOf(fields.message) ?? textOf(fields.detail);
  if (!name && !message) return null;
  return [name ?? "ゲート", verdict, message].filter(Boolean).join(" — ");
}

export function anatomiaStageBlocks(value: unknown): string[] {
  const fields = asFields(value);
  if (!fields) return ["Anatomia 解析の結果を読み取れませんでした。"];
  const domains = listOf(fields.domains)
    .flatMap((domain) => optionalLine(textOf(domain) ?? textOf(asFields(domain)?.name)));
  const verify = asFields(fields.verify);
  const verdict = verify && typeof verify.pass === "boolean" ? (verify.pass ? "通過" : "不合格") : "未取得";
  const gates = listOf(verify?.gates).flatMap((gate) => optionalLine(gateLine(gate)));
  const violations = listOf(fields.changedViolations).flatMap((violation) => optionalLine(violationLine(violation)));
  const functions = listOf(fields.changedFunctions).flatMap((changed) => optionalLine(functionLine(changed)));
  return [
    [
      `対象ドメイン: ${domains.length > 0 ? domains.join(", ") : "なし"}`,
      `アーキテクチャ検証: ${verdict}`,
      ...gates.map((gate) => `- ${gate}`),
    ].join("\n"),
    section("アーキテクチャ違反", bulletLines(violations, "アーキテクチャ違反はありません。")),
    section(`変更した関数 (${functions.length} 件)`, bulletLines(functions, "変更した関数の記録はありません。")),
  ];
}

/** Revisor 画面の「セキュリティスキャン」行。 記録が無い場合は画面と同じく未実施とする。 */
export function securityLine(value: unknown): string {
  const fields = asFields(value);
  if (!fields) return "セキュリティスキャン: 未実施";
  const status = textOf(fields.status) ?? "結果不明";
  const reason = textOf(fields.reason);
  if (status === "skipped") return `セキュリティスキャン: スキップ — ${reason ?? "理由は記録されていません"}`;
  const threshold = textOf(fields.failOnSeverity);
  return `セキュリティスキャン: ${securityStatusLabel(status)} / 検出 ${numberOf(fields.totalFindings) ?? "未取得"} 件`
    + (threshold ? ` (閾値 ${threshold})` : "")
    + (reason ? ` — ${reason}` : "");
}

function securityFindings(value: unknown): string[] {
  return listOf(asFields(value)?.findings).flatMap((item) => {
    const finding = asFields(item);
    const rule = textOf(finding?.rule);
    if (!finding || !rule) return [];
    return [`[${textOf(finding.severity) ?? "重大度不明"}] ${rule}${locationOf(finding)}`];
  });
}

export function securityStageBlocks(value: unknown): string[] {
  const fields = asFields(value);
  if (!fields || textOf(fields.status) === "skipped") return [securityLine(value)];
  return [
    securityLine(value),
    section("セキュリティ finding", bulletLines(securityFindings(value), "セキュリティ finding はありません。")),
  ];
}

function planLines(value: unknown): string[] {
  const plan = asFields(value);
  if (!plan) return ["レビュー計画は記録されていません。"];
  const lines = [
    `計画元: ${plan.source === "advised" ? `管制プランナー (${textOf(plan.advisor) ?? "名称未記録"})` : "決定的ルール"}`,
  ];
  const advisorError = textOf(plan.advisorError);
  if (advisorError) lines.push(`管制プランナー: ${advisorError} — 決定的な計画を使用`);
  const profile = asFields(plan.changeProfile);
  if (profile) {
    lines.push(
      `変更種別: ${stringsOf(profile.kinds).join(", ") || "—"}`,
      `変更規模: ${numberOf(profile.changedFiles) ?? "未取得"} ファイル / ${numberOf(profile.changedLines) ?? "未取得"} 行`,
      `動作面: ${stringsOf(profile.runtimeSurfaces).join(", ") || "—"}`,
    );
  }
  const review = asFields(plan.review);
  if (review) lines.push(`レビュー方式: ${textOf(review.label) ?? textOf(review.tier) ?? "—"}`);
  const stages = listOf(plan.stages).flatMap((item) => {
    const stage = asFields(item);
    const id = textOf(stage?.id);
    if (!stage || !id) return [];
    const skipped = stage.run === false;
    return [`- ${skipped ? "—" : "○"} ${id} : ${skipped ? "スキップ — " : ""}${textOf(stage.reason) ?? "理由未記録"}`];
  });
  if (stages.length > 0) lines.push("ステージ:", ...stages);
  const skippedTests = listOf(asFields(plan.testSelection)?.skipped).flatMap((item) => {
    const test = asFields(item);
    const name = textOf(test?.name);
    return name ? [`${name} — ${textOf(test?.reason) ?? "理由未記録"}`] : [];
  });
  lines.push("省略した登録テスト:", ...bulletLines(skippedTests, "省略した登録テストはありません。"));
  return lines;
}

/**
 * レビュー本文。 旧形式 (本文を保存する前の Revisor) の記録は未取得と明記し、
 * レビュアー名や成功の表示でレビュー内容を代替しない。
 */
export function reviewTextBlock(fields: Fields, title = "レビュー本文"): string {
  if (!hasField(fields, "reviewerOutput")) {
    return section(title, ["この記録は Revisor がレビュー本文を保存する前の形式のため、本文は未取得です。"]);
  }
  const text = textOf(fields.reviewerOutput);
  return section(title, [text ?? "レビュー本文は記録されていません。"]);
}

export function reviewStageBlocks(value: unknown): string[] {
  const fields = asFields(value);
  if (!fields) return ["モデルレビューの結果を読み取れませんでした。"];
  return [
    `レビュアー: ${reviewerLabel(fields.reviewer)}`,
    section("レビュー計画", planLines(fields.plan)),
    reviewTextBlock(fields),
  ];
}

function conclusionText(value: unknown): string {
  const conclusion = textOf(value);
  if (conclusion === "success") return "審査を通過しました。";
  if (conclusion === "action_required") return "人間の対応が必要です。";
  return `結論を判別できません (${conclusion ?? "未記録"})。`;
}

export interface FinalOutcomeOptions {
  /** 同じ本文を全文掲載済みの記録の見出し。 あれば本文を再掲せず、その投稿を案内する。 */
  reviewTextPostedAs: string | null;
}

export function finalOutcomeBlocks(value: unknown, options: FinalOutcomeOptions): string[] {
  const fields = asFields(value);
  if (!fields) return ["最終結果の内容を読み取れませんでした。"];
  const gate = asFields(fields.anatomiaGate);
  const checks = reportChecksOf(fields.ci);
  const reused = stringsOf(fields.reusedStages);
  const reviewReused = reused.includes("review");
  const summary = [
    `結論: ${conclusionText(fields.conclusion)}`,
    `レビュアー: ${reviewerLabel(fields.reviewer)}`,
    ...(gate ? [`Anatomia 前段ゲート: ${textOf(gate.status) ?? "結果不明"} — ${textOf(gate.message) ?? "説明なし"}`] : []),
    securityLine(fields.security),
    ...(hasField(fields, "reusedStages")
      ? [`引き継いだ審査段階: ${reused.map((stage) => reviewStageLabel(stage)).join(", ") || "なし"}`]
      : []),
  ];
  const reviewTitle = reviewReused ? "レビュー本文 (前回の審査から引き継ぎ)" : "レビュー本文";
  return [
    summary.join("\n"),
    section("ブロック理由", bulletLines(stringsOf(fields.reasons), "ブロック理由はありません。")),
    section("所見 (マージは止めない)", bulletLines(stringsOf(fields.advisories), "所見はありません。")),
    checks
      ? section(`登録チェック: ${checkSummary(checks)}`, checkSections(checks))
      : section("登録チェック", ["登録チェックの結果は記録されていません。"]),
    options.reviewTextPostedAs
      ? section(reviewTitle, [`「${options.reviewTextPostedAs}」の投稿に全文を掲載しています。`])
      : reviewTextBlock(fields, reviewTitle),
  ];
}
