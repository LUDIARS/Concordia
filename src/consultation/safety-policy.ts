/** Only categorical decisions leave the classifier. Never echo the sensitive input or matched term. */
export type ConsultationSafetyReason = "personal_data" | "confidential_data" | "unsafe_tool" | "guard_unavailable";
export interface ConsultationSafetyDecision { blocked: boolean; reason: ConsultationSafetyReason | null; penaltyEligible: boolean }

export function safetyDecision(reason: ConsultationSafetyReason | null): ConsultationSafetyDecision {
  return { blocked: reason !== null, reason, penaltyEligible: reason === "personal_data" || reason === "confidential_data" };
}

/** シェル系のツール名 (claude の Bash、 codex の shell / exec_command など)。 tools/consult-codex-hook.mjs と揃える。 */
const SHELL_TOOLS = /^(bash|shell|local_shell|exec_command|unified_exec)$/i;
/**
 * 相談者が送った公開 Notion / Google Drive のリンクの取得コマンド (consult-fetch-link.ts)。 相談フォルダの
 * `_source/tools/fetch-link/fetch-link.mjs` を node で実行するだけのもの。 別のコマンドをつなげられる記号は許さない。
 * どの相談フォルダのスクリプトかの厳密な一致は、 前段の権限 (claude の settings) とフック (codex) が持つ。
 */
const FETCH_LINK_COMMAND = /^node\s+"?[^\s";&|`$<>]*[\\/]_source[\\/]tools[\\/]fetch-link[\\/]fetch-link\.mjs"?(\s|$)/;
const CHAINING = /[;&|`$<>\r\n]/;

export function isConsultFetchLinkCommand(command: string): boolean {
  const trimmed = command.trim();
  return FETCH_LINK_COMMAND.test(trimmed) && !CHAINING.test(trimmed);
}

/**
 * 相談セッションで使ってよいツール。 シェル系は公開リンクの取得コマンドだけ (2026-10-06 neco 指示「Notion の
 * 公開リンクの取得が、相談ハーネスでブロックされる」: 取得コマンドが Bash ごと unsafe_tool で止まっていた)。
 */
export function consultationToolAllowed(tool: string, command = ""): boolean {
  if (["WebSearch", "WebFetch", "TodoWrite", "Skill", "web_search", "web.run"].includes(tool)) return true;
  return SHELL_TOOLS.test(tool) && isConsultFetchLinkCommand(command);
}

export function parseSafetyVerdict(raw: string): ConsultationSafetyDecision {
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { decision?: unknown; category?: unknown };
    if (parsed.decision === "allow" && parsed.category === "none") return safetyDecision(null);
    if (parsed.decision === "deny" && (parsed.category === "personal_data" || parsed.category === "confidential_data")) {
      return safetyDecision(parsed.category);
    }
  } catch { /* Malformed classifier output is a block, never permission or a penalty. */ }
  return safetyDecision("guard_unavailable");
}
