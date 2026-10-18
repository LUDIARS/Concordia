/** @implements spec/feature/discord-chat-relay.md — 転送先の登録 (dcr-C-1) */
/**
 * The accepted shape is spelled out here rather than imported so the predicate states
 * the spec instead of echoing the parser it checks.
 */
const NAME = /^[a-z0-9-]+$/;
const SNOWFLAKE = /^[0-9]{17,20}$/;

function isHttpUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  try {
    const protocol = new URL(raw).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

interface TargetShape { name?: unknown; url?: unknown; enabled?: unknown; channelIds?: unknown }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const entries = args[0];
    if (!Array.isArray(entries) || !result || typeof result !== "object") return false;
    const { targets, errors } = result as { targets?: unknown; errors?: unknown };
    if (!Array.isArray(targets) || !Array.isArray(errors)) return false;
    const names = targets.map((target: TargetShape) => target?.name);
    const channels = targets.flatMap((target: TargetShape) => (Array.isArray(target?.channelIds) ? target.channelIds : []));
    const valid = targets.every((target: TargetShape) =>
      typeof target?.name === "string" && NAME.test(target.name)
      && isHttpUrl(target.url) && typeof target.enabled === "boolean"
      && Array.isArray(target.channelIds) && target.channelIds.length >= 1
      && target.channelIds.every((id: unknown) => typeof id === "string" && SNOWFLAKE.test(id)));
    // No channel belongs to two targets, and every input entry is either adopted or explained.
    return valid
      && new Set(names).size === names.length
      && new Set(channels).size === channels.length
      && targets.length + errors.length === entries.length;
  },
};
