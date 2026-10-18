/** Pure interpretation of Revisor completion notices. @implements CC-RV-TERMINAL-01 */
export type RevisorTerminalKind = "merged" | "failed" | "action_required";

const CONTINUATION_HEADER = "[Revisor 通知後の継続]";

/** Match the producer's first line, not quoted findings or arbitrary error words. */
export function revisorTerminalKind(source: string | null | undefined, text: string): RevisorTerminalKind | null {
  if (source !== "revisor") return null;
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  if (/^✅ Revisor レビュー完了: \S+#\d+ は Test OK で自動マージされました。$/.test(firstLine)) return "merged";
  if (/^⚠️ Revisor レビュー失敗: \S+#\d+ は審査を完了できませんでした。$/.test(firstLine)) return "failed";
  if (/^🔴 Revisor レビュー完了: \S+#\d+ はマージできません。$/.test(firstLine)) return "action_required";
  return null;
}

/** Enrich the existing command; this never emits a second wake-up or grants authority. */
export function withRevisorContinuation(source: string | null | undefined, text: string): string {
  const kind = revisorTerminalKind(source, text);
  if (!kind || text.split(/\r?\n/).includes(CONTINUATION_HEADER)) return text;
  const next = kind === "merged"
    ? "対応する PR のマージ結果と反映状態、Actio タスクの現状態を照合し、許可済みの反映確認と残作業を続けてください。マージ済みだけで完了とせず、未確認の反映を成功と扱わないでください。"
    : "対応する PR の現状態と指摘、Actio タスクを確認し、既存の依頼範囲で修正できる項目を修正して再審査へ進めてください。結果不明の提出・再実行を重ねず、人間判断が必要な指摘は待機を維持してください。";
  return `${text}\n\n${CONTINUATION_HEADER}\n${next}\nこれは新たな実行許可ではありません。明示停止、Goal & Go OFF、未回答の確認、人間判断待ち、継続上限を維持してください。テスト・再起動・デプロイは既存の許可範囲に従い、進められる作業がなければ理由を示して待機してください。`;
}
