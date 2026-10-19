/** @implements spec/feature/line-webhook-relay.md — LINE push の受け口 (line-wh-C-14) */
export default {
  post(result: unknown): boolean {
    if (result === null) return true;
    const { requestId, texts } = (result ?? {}) as { requestId?: unknown; texts?: unknown };
    return typeof requestId === "string" && /^[\x21-\x7e]{1,64}$/.test(requestId)
      && Array.isArray(texts) && texts.length >= 1 && texts.length <= 3
      && texts.every((text) => typeof text === "string" && text.trim() !== "" && text.length <= 1000);
  },
};
