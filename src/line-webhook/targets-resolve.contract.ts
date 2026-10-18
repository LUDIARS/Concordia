/** @implements spec/feature/line-webhook-relay.md — 受け口 (line-wh-C-2) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const name = args[1];
    if (result === null) {
      const targets = Array.isArray(args[0]) ? args[0] as Array<{ name?: unknown; enabled?: unknown }> : [];
      // null is only correct when no enabled target of that name exists.
      return !targets.some((target) => target?.name === name && target?.enabled === true && /^[a-z0-9-]+$/.test(String(name)));
    }
    const target = result as { name?: unknown; enabled?: unknown };
    return target.name === name && target.enabled === true;
  },
};
