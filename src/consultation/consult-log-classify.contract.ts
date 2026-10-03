/** @implements SPEC-CONSULT-LOG */
/**
 * C-3: a human utterance (user from discord / slack / web) is "requester", a final answer
 * (assistant final_answer or summary) is "answer", and Cc directives, intermediate messages and tool output are null.
 */
export default {
  post(result: unknown, message: unknown): boolean {
    if (!message || typeof message !== "object") return result === null;
    const { author_type, author_platform, metadata } = message as {
      author_type?: unknown; author_platform?: unknown; metadata?: { phase?: unknown } | null;
    };
    if (author_type === "user") {
      return result === (["discord", "slack", "web"].includes(String(author_platform)) ? "requester" : null);
    }
    if (author_type === "summary" || (author_type === "assistant" && metadata?.phase === "final_answer")) {
      return result === "answer";
    }
    return result === null;
  },
};
