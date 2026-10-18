/** @implements spec/feature/discord-chat-relay.md — 中継トークン (dcr-C-5) */
export default {
  post(result: unknown): boolean {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const entries = Object.entries(result as Record<string, unknown>);
    // Only the presence flag leaves this module; the token itself never does.
    return entries.length === 1 && entries[0]![0] === "relay_token_set" && typeof entries[0]![1] === "boolean";
  },
};
