/** @implements SPEC-BOUNTY-INTAKE */
/**
 * C-2: the idempotency key names its intake surface, a session key carries the session id,
 * and the report text never appears in the key as plain text (the key is logged and indexed;
 * the text stays in the ledger only, spec/feature/bug-bounty.md §10).
 */
const MIN_LEAK_CHARS = 12;

function leaks(key: string, text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  return trimmed.length >= MIN_LEAK_CHARS && key.includes(trimmed);
}

export default {
  post(
    result: unknown,
    input: {
      platform?: unknown;
      clientKey?: unknown;
      sessionId?: unknown;
      fields?: { what_happened?: unknown; repro_steps?: unknown };
    } | undefined,
  ): boolean {
    const platform = String(input?.platform ?? "");
    const hasClientKey = typeof input?.clientKey === "string" && input.clientKey.trim().length > 0;
    if (result === null) return platform !== "session" && !hasClientKey;
    if (typeof result !== "string") return false;
    if (!result.startsWith(`${platform}:`)) return false;
    if (platform === "session" && !result.includes(String(input?.sessionId ?? ""))) return false;
    return !leaks(result, input?.fields?.what_happened) && !leaks(result, input?.fields?.repro_steps);
  },
};
