/** @implements spec/feature/line-webhook-relay.md — postback の包み (line-wh-C-10) */
const LIMIT = 300;
const ACTION_TYPES = new Set(["postback", "datetimepicker"]);

function postbackData(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => postbackData(item, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (ACTION_TYPES.has(String(record.type)) && typeof record.data === "string") found.push(record.data);
    Object.values(record).forEach((item) => postbackData(item, found));
  }
  return found;
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const reply = args[0] as { messages?: unknown } | undefined;
    const prefix = `cc:${String(args[1])}:`;
    const original = postbackData(reply?.messages);
    if (original.some((data) => prefix.length + data.length > LIMIT)) return result === reply;
    const wrapped = postbackData((result as { messages?: unknown } | null)?.messages);
    return wrapped.length === original.length
      && wrapped.every((data, index) => data === `${prefix}${original[index]}` && data.length <= LIMIT);
  },
};
