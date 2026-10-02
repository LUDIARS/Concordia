/**
 * 相談のモデルを相談者の職種で決める (spec/feature/tech-consultation.md §6、 2026-10-02 neco 指示)。
 *
 * 「エンジニアと企画の相談は Opus、 デザイナーとサウンドの相談は Astra で起動。 モデルとエフォートは自動 (medium)」
 * 「GLab も Astra」。 事前ヒアリングの役職から読み、 読めなければ Opus。 起動時にモデルを聞き返さない。
 *
 * 子会社の相談は claude なら --tools、 codex (Astra) ならシェル・プラグイン・AGENTS.md・MCP を外して閉じ込める
 * (CC-CONSULT-INV-07)。 codex の読み取り専用 sandbox は Windows でファイルの読み取りを止めないため、
 * 読む手段 (shell_tool) そのものを外す。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { consultRoleFolder } from "./consult-role.js";

export type ConsultModelNick = "opus" | "astra";

/** 相談の effort (自動)。 */
export const CONSULT_EFFORT = "medium";

/** 役職から相談のモデルを選ぶ。 デザイナー・サウンドは Astra、 それ以外 (エンジニア・企画・不明) は Opus。 */
export function consultModelForRole(roleTitle: string | null | undefined): ConsultModelNick {
  const folder = consultRoleFolder(roleTitle);
  return folder === "designer" || folder === "sound" ? "astra" : "opus";
}

/** モデルごとの起動テンプレート (call_name)。 env で差し替えられる。 */
export function consultTemplateFor(nick: ConsultModelNick, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return nick === "astra"
    ? env.CONCORDIA_CONSULT_ASTRA_TEMPLATE?.trim() || "astra-mid"
    : env.CONCORDIA_CONSULT_OPUS_TEMPLATE?.trim() || "opus-5-5-movable";
}

/** effort を provider ごとの起動オプションにする。 */
export function consultEffortOptions(provider: string): Record<string, string> {
  return provider === "claude" ? { effort: CONSULT_EFFORT } : { model_reasoning_effort: CONSULT_EFFORT };
}

const CODEX_CONFINEMENT_ARGS: readonly string[] = Object.freeze([
  "-s", "read-only",
  "--disable", "shell_tool",
  "--disable", "plugins",
  "-c", "project_doc_max_bytes=0",
  "-c", "mcp_servers={}",
]);

/**
 * 子会社の相談を閉じ込める起動引数。 閉じ込められない provider は null (起動しない)。
 * claude の引数は呼び出し側が渡す (projectless-consult.ts の PROJECTLESS_CONSULT_CLAUDE_ARGS)。
 */
export function confinementArgsFor(provider: string, claudeArgs: readonly string[]): readonly string[] | null {
  if (provider === "claude") return claudeArgs;
  if (provider === "codex") return CODEX_CONFINEMENT_ARGS;
  return null;
}
