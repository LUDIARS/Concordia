/** @implements spec/feature/line-webhook-relay.md — サービスの応答と LINE への返信 (line-wh-C-13) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(args[0] as Uint8Array).toString("utf8"));
    } catch {
      return result === null;
    }
    if (result === null) return true;
    const record = parsed as Record<string, unknown>;
    const answer = result as { replies?: unknown; linked?: unknown; unlinked?: unknown };
    const flagOk = (raw: unknown, value: unknown) =>
      (raw === undefined || typeof raw === "boolean") && value === (raw === true);
    return Array.isArray(answer.replies) && Array.isArray(record?.replies)
      && answer.replies.length === record.replies.length
      && flagOk(record.linked, answer.linked) && flagOk(record.unlinked, answer.unlinked);
  },
};
