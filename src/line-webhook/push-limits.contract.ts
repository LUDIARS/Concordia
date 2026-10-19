/** @implements spec/feature/line-webhook-relay.md — LINE push の送信上限 (line-wh-C-18) */
const LIMIT = 10;
const WINDOW_MS = 60_000;

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const [history, now] = args as [unknown, unknown];
    if (!Array.isArray(history) || typeof now !== "number") return true;
    const { allowed, history: next } = (result ?? {}) as { allowed?: unknown; history?: unknown };
    if (typeof allowed !== "boolean" || !Array.isArray(next)) return false;
    const recent = (history as number[]).filter((at) => now - at < WINDOW_MS);
    const inWindow = next.every((at) => typeof at === "number" && now - at < WINDOW_MS);
    return inWindow && next.length <= LIMIT
      && allowed === (recent.length < LIMIT)
      && next.length === recent.length + (allowed ? 1 : 0);
  },
};
