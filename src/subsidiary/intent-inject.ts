/**
 * 子会社ゲート専用の intent 注入。
 *
 * 子会社は Sonnet ガード 1 枚のみで、 src/harness/** のルールベース判定
 * (heuristic / local LLM / haiku の prompt analyzer) と未接続だった。
 * ここでは allow 確定した instruction を analyzer に通し、 判定結果 (意図・懸念・
 * 対処・適用ハーネスルール) を spawn する delegation の extra_prompt へ前置きする。
 * 「子会社のみ」 という限定は呼び出し位置 (subsidiary/gate.ts の allow 分岐) で
 * 構造的に保証される — 本社 delegation はこの経路を通らない。
 *
 * intent 注入は追加の安全レイヤ (advisory)。 analyzer 失敗時はゲートを止めず
 * heuristic フォールバック (analyzer 内蔵) に任せ、 それも失敗したら注入なしで進む。
 */

import type { IntentHarnessRule, PromptIntentContext } from "../harness/prompt-intent.js";
import {
  analyzePromptWithClaudeModel,
  analyzePromptWithLocalLlm,
  heuristicPromptAnalysis,
  type PromptAnalyzerResult,
} from "../harness/local-prompt-analyzer.js";
import type { RunClaudeFn } from "./guard.js";

/** /v1/harness/intent と同じモード切替 (off = heuristic のみ)。 */
function promptAnalyzerMode(): string {
  return (process.env.CONCORDIA_PROMPT_ANALYZER || "local").toLowerCase();
}

export interface SubsidiaryIntentInput {
  instruction: string;
  project: string | null;
  rules: IntentHarnessRule[];
  runClaude?: RunClaudeFn;
}

export interface SubsidiaryIntentOutcome {
  /** extra_prompt へ前置きする注入本文。 */
  preamble: string;
  result: PromptAnalyzerResult;
}

/** instruction を analyzer に通し、 spawn プロンプトへ前置きする注入文を作る。 */
export async function buildSubsidiaryIntentInjection(
  input: SubsidiaryIntentInput,
): Promise<SubsidiaryIntentOutcome> {
  const ctx: PromptIntentContext = {
    prompt: input.instruction,
    project: input.project ?? undefined,
    branch: undefined,
    rules: input.rules,
    gates: [],
  };
  const mode = promptAnalyzerMode();
  const result = mode === "off"
    ? heuristicPromptAnalysis(ctx)
    : (mode === "haiku" || mode === "claude" || mode === "sonnet") && input.runClaude
      ? await analyzePromptWithClaudeModel(ctx, input.runClaude, { model: mode === "haiku" ? "haiku" : mode })
      : await analyzePromptWithLocalLlm(ctx);

  const { verdict, analysis } = result;
  const lines: string[] = [];
  lines.push("## ハーネス intent 判定 (Concordia 子会社ゲート)");
  lines.push(`- 判定: ${verdict.decision} / リスク: ${verdict.risk} (source: ${result.source})`);
  if (verdict.intent) lines.push(`- 読み取った意図: ${verdict.intent}`);
  if (verdict.concerns.length) lines.push(`- 懸念: ${verdict.concerns.join(", ")}`);
  if (verdict.advice) lines.push(`- 対処: ${verdict.advice}`);
  if (analysis.safety.reasons.length) lines.push(`- 安全性 (${analysis.safety.level}): ${analysis.safety.reasons.join(", ")}`);
  if (analysis.target_services.length) lines.push(`- 対象サービス候補: ${analysis.target_services.join(", ")}`);
  if (input.rules.length) {
    lines.push("- 適用ハーネスルール:");
    for (const r of input.rules) lines.push(`  - [${r.kind}] ${r.title}: ${r.description}`);
  }
  lines.push("");
  lines.push("上記の判定と社内ハーネスルールを厳守して作業すること。懸念に該当する操作は行う前に必ず確認を取ること。");

  return { preamble: lines.join("\n"), result };
}
