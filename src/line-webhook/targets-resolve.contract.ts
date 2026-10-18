/** @implements spec/feature/line-webhook-relay.md — チャネルとサービス (line-wh-C-2) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!Array.isArray(result)) return false;
    const targets = Array.isArray(args[0]) ? args[0] as Array<{ name?: unknown; channel?: unknown; enabled?: unknown }> : [];
    const channel = args[1];
    if (typeof channel !== "string" || !/^[a-z0-9-]+$/.test(channel)) return result.length === 0;
    // Exactly the enabled services of that channel, in the configured order.
    const expected = targets.filter((target) => target?.channel === channel && target?.enabled === true);
    return result.length === expected.length && result.every((target, index) => target === expected[index]);
  },
};
