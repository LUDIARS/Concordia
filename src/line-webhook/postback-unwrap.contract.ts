/** @implements spec/feature/line-webhook-relay.md — postback の包み (line-wh-C-11) */
export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const data = args[0];
    if (result === null) return typeof data !== "string" || !/^cc:[a-z0-9-]+:/.test(data);
    const unwrapped = result as { service?: unknown; data?: unknown };
    return typeof unwrapped.service === "string" && typeof unwrapped.data === "string"
      && `cc:${unwrapped.service}:${unwrapped.data}` === data;
  },
};
