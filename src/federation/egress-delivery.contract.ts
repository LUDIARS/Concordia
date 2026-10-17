/** @implements spec/feature/federation-link.md CC-FED-EGRESS-MENTION-01 */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!result || typeof result !== "object") return false;
    const delivery = result as Record<string, unknown>;
    const hqMention = args[1];
    return typeof hqMention === "string" && hqMention.length > 0
      ? Object.hasOwn(delivery, "mention_user_id") && delivery.mention_user_id === hqMention
      : !Object.hasOwn(delivery, "mention_user_id");
  },
};
