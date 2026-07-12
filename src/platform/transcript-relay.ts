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
    if (typeof value.phase === "string" && value.phase !== "final_answer") return null;
    if (options.messageOptimizationEnabled === true && options.provider !== "codex-cli") return null;
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
