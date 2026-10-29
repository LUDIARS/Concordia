/** @implements spec/feature/discord-chat-relay.md — お知らせチャンネル (dcr-C-7) */
interface FactsShape { authorId?: unknown; authorIsBot?: unknown; webhookId?: unknown; system?: unknown }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const facts = args[0] as FactsShape | null;
    const self = args[1];
    if (!facts || typeof result !== "boolean") return false;
    // Only a bot or webhook post that is not a system message and not Cc's own bot (known id) is a notice.
    const expected = facts.system !== true
      && typeof self === "string"
      && (facts.authorIsBot === true || typeof facts.webhookId === "string")
      && facts.authorId !== self;
    return result === expected;
  },
};
