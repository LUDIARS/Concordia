/** @implements spec/feature/line-webhook-relay.md — LINE push の送り先 (line-wh-C-16) */
interface Row { channel?: unknown; talkId?: unknown; service?: unknown; isDefault?: unknown }

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!Array.isArray(result)) return false;
    const [links, channel, service] = args;
    const rows = Array.isArray(links) ? links as Row[] : [];
    const expected = new Set(rows
      .filter((row) => row?.channel === channel && row?.service === service && row?.isDefault === true)
      .map((row) => row.talkId));
    return new Set(result).size === result.length && result.length === expected.size
      && result.every((talkId) => expected.has(talkId));
  },
};
