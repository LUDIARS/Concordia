import { shouldDropForRelay, stripAskMarkerBlocks } from "./egress-filters.js";

export interface RelayableTextFrame {
  role: "assistant" | "summary";
  text: string;
}

export function extractRelayableTextFrame(
  kind: string,
  payload: unknown,
  options: { messageOptimizationEnabled?: boolean; provider?: string | null } = {},
): RelayableTextFrame | null {
  if (kind === "text") {
    const value = payload as { role?: string; text?: string; phase?: string } | null | undefined;
    if (value?.role !== "assistant" || typeof value.text !== "string" || !value.text) return null;
    if (options.messageOptimizationEnabled === true) {
      // 最適化 ON: 人間向けの最終回答のみ中継する。 Codex 以外は代替の最適化済み経路に
      // 任せて生 text frame は出さない。 Codex は phase=final_answer 以外 (commentary 等
      // の作業中コメント) を落とす。
      if (options.provider !== "codex-cli") return null;
      if (typeof value.phase === "string" && value.phase !== "final_answer") return null;
    }
    // 最適化 OFF (既定): commentary を含む作業中メッセージも全て中継する
    // (2026-07-18 neco 指示。 2026-05-27 の final_answer 限定は最適化 ON 時のみに縮小)。
    const text = stripAskMarkerBlocks(value.text);
    if (!text || shouldDropForRelay(text)) return null;
    return { role: "assistant", text };
  }
  if (kind === "summary") {
    const value = payload as { text?: string; summary?: string } | null | undefined;
    const text = typeof value?.text === "string"
      ? value.text
      : typeof value?.summary === "string"
        ? value.summary
        : null;
    if (!text || shouldDropForRelay(text)) return null;
    return { role: "summary", text };
  }
  return null;
}
