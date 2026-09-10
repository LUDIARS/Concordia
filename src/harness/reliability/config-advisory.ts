// @spec ハーネス信頼性の実装境界
export interface ConfigSnapshot {
  provider: string;
  model?: string;
  hooks_enabled?: boolean;
  hook_trust?: "trusted" | "review_required" | "unknown";
  context_window?: number;
  auto_compact_limit?: number;
  hook_events?: string[];
  uses_deprecated_codex_hooks?: boolean;
}

/** Only observed configuration is assessed. No defaults or model support are guessed. */
export function configurationAdvice(snapshot: ConfigSnapshot): string[] {
  const advice: string[] = [];
  if (snapshot.provider !== "codex-cli" && snapshot.provider !== "claude-code") return ["このproviderの公式フック適用状況は未対応・未確認です。"];
  if (snapshot.hooks_enabled === false) advice.push("フックが無効です。認証切れ・コンパクションの観測も行われません。");
  if (snapshot.hook_trust === "review_required") advice.push("変更されたフックの信頼確認が未完了です。Codexの /hooks で対象定義を確認してください。");
  if (snapshot.provider === "codex-cli" && snapshot.uses_deprecated_codex_hooks) advice.push("codex_hooks は非推奨の別名です。公式の features.hooks 設定を使用してください。");
  if (snapshot.context_window != null && snapshot.auto_compact_limit != null && snapshot.auto_compact_limit >= snapshot.context_window) advice.push("自動コンパクション閾値が設定上のコンテキスト窓以上です。実モデルの窓と上限を確認してください。");
  if (snapshot.hook_events && !snapshot.hook_events.includes("PreCompact")) advice.push("PreCompactの登録がありません。圧縮前の資料保存を観測できません。");
  if (snapshot.provider === "codex-cli" && snapshot.hook_events?.includes("PostToolUseFailure")) advice.push("Codexの公式フック一覧にPostToolUseFailureはありません。対応するPostToolUse経路を確認してください。");
  return advice;
}
