/** @implements spec/feature/line-webhook-relay.md — チャネルの秘密値 (line-wh-C-6) */
const FIELDS = ["channel_secret_set", "channel_access_token_set"];

export default {
  post(result: unknown): boolean {
    if (!result || typeof result !== "object") return false;
    const entries = Object.entries(result as Record<string, unknown>);
    // Only the two "is it set" flags, never a value.
    return entries.length === FIELDS.length
      && entries.every(([key, value]) => FIELDS.includes(key) && typeof value === "boolean");
  },
};
