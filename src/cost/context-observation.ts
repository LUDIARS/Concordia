export interface ContextObservation {
  tokens: number;
  windowTokens: number | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Latest completed request input, never cumulative billed usage or guessed fixed overhead. */
export function contextObservationFromLines(lines: readonly string[], provider: string): ContextObservation | null {
  let current: ContextObservation | null = null;
  for (const line of lines) {
    let record: Record<string, unknown> | null;
    try { record = object(JSON.parse(line)); } catch { continue; }
    if (!record || record.isSidechain === true) continue;
    if (record.type === "compacted" || (record.type === "system" && record.subtype === "compact_boundary")) {
      current = null;
      continue;
    }
    if (provider === "codex-cli") {
      const payload = object(record.payload);
      if (record.type !== "event_msg" || payload?.type !== "token_count") continue;
      const info = object(payload.info);
      const usage = object(info?.last_token_usage);
      const tokens = nonnegative(usage?.input_tokens);
      if (tokens === null) continue;
      const window = nonnegative(info?.model_context_window);
      current = { tokens, windowTokens: window !== null && window > 0 ? window : null };
    } else if (provider === "claude-code" && record.type === "assistant") {
      const usage = object(object(record.message)?.usage);
      const input = nonnegative(usage?.input_tokens);
      if (input === null) continue;
      const read = usage?.cache_read_input_tokens === undefined ? 0 : nonnegative(usage.cache_read_input_tokens);
      const created = usage?.cache_creation_input_tokens === undefined ? 0 : nonnegative(usage.cache_creation_input_tokens);
      if (read === null || created === null) continue;
      // Model names and first-turn usage do not prove a context window.
      current = { tokens: input + read + created, windowTokens: null };
    }
  }
  return current;
}
