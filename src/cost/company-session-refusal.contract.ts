/** @implements spec/feature/usage-budgets.md §9 — cap-C-3 上限で断った理由を起動した人へ返す */
/**
 * cap-C-3: the chat surfaces recover the human-facing refusal only from a session-cap API error,
 * and never mistake another error for it.
 */
const PREFIX = "session_cap_reached: ";

export default {
  post(result: unknown, input: unknown): boolean {
    const error = String(input);
    const at = error.indexOf(PREFIX);
    if (at < 0) return result === null;
    return result === error.slice(at + PREFIX.length);
  },
};
