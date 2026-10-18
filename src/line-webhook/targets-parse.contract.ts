/** @implements spec/feature/line-webhook-relay.md — 転送先の登録 (line-wh-C-1) */
/**
 * The accepted shape is spelled out here rather than imported so the predicate states
 * the spec instead of echoing the parser it checks.
 */
const NAME = /^[a-z0-9-]+$/;

function isHttpUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const entries = args[0];
    if (!Array.isArray(entries) || !result || typeof result !== "object") return false;
    const { targets, errors } = result as { targets?: unknown; errors?: unknown };
    if (!Array.isArray(targets) || !Array.isArray(errors)) return false;
    const names = targets.map((target: { name?: unknown }) => target?.name);
    const valid = targets.every((target: { name?: unknown; url?: unknown; enabled?: unknown }) =>
      typeof target?.name === "string" && NAME.test(target.name)
      && isHttpUrl(target.url) && typeof target.enabled === "boolean");
    // Every input entry is either adopted or explained; nothing is silently dropped.
    return valid && new Set(names).size === names.length && targets.length + errors.length === entries.length;
  },
};
