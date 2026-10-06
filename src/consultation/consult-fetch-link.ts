/**
 * 相談セッションに許す唯一のコマンド: 相談者が送った公開 Notion / Google Drive のリンクの取得
 * (spec/feature/tech-consultation.md §6、 CC-CONSULT-INV-07、 2026-10-03 neco 指示)。
 *
 * 取得スクリプトの正本は相談フォルダの `_source/tools/fetch-link/fetch-link.mjs` (相談フォルダのリポが持つ)。
 * Cc は場所と許可だけを決める:
 * - claude: 役職フォルダの `.claude/settings.local.json` の permissions で、 このコマンドの前方一致だけを許し、
 *   ほかは聞かずに拒否する (`defaultMode: "dontAsk"`)。
 * - codex (Astra): 起動 env にスクリプトの場所を渡し、 フック (tools/consult-codex-hook.mjs) がほかのシェルを止める。
 *
 * 業務判断だけを持つ純関数。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { join } from "node:path";

/** 起動 env に入れる取得スクリプトの絶対パス (tools/consult-fetch-link-command.mjs の FETCH_LINK_SCRIPT_ENV と揃える)。 */
export const CONSULT_FETCH_LINK_SCRIPT_ENV = "CONCORDIA_CONSULT_FETCH_LINK_SCRIPT";
/** ツール制限を外した部署の相談 (consult_tools=all)。 tools/consult-codex-hook.mjs の ALL_TOOLS_ENV と揃える。 */
export const CONSULT_ALL_TOOLS_ENV = "CONCORDIA_CONSULT_ALL_TOOLS";

const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");

/** 相談フォルダの取得スクリプト (前方スラッシュ。 スキルに書くコマンドと同じ形)。 */
export function consultFetchLinkScript(root: string): string {
  return slash(join(root, "_source", "tools", "fetch-link", "fetch-link.mjs"));
}

/**
 * 相談セッションの claude に許すツール (それ以外は聞かずに拒否する)。 部署の consult_tools が `all` なら制限を外す
 * (2026-10-06 neco 指示「Consult のハーネスをすべて許可する設定」)。
 */
export function consultClaudePermissions(
  root: string,
  options: { allTools?: boolean } = {},
): { defaultMode: "dontAsk"; allow: string[] } | { defaultMode: "bypassPermissions" } {
  if (options.allTools) return { defaultMode: "bypassPermissions" };
  return {
    defaultMode: "dontAsk",
    allow: ["WebSearch", "TodoWrite", "Skill", `Bash(node ${consultFetchLinkScript(root)}:*)`],
  };
}
