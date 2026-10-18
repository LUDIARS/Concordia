/** @implements spec/feature/line-webhook-relay.md — 振り分け (line-wh-C-7) */
interface Service { name?: unknown; keywords?: unknown }

function keywordsOf(service: Service): string[] {
  return Array.isArray(service?.keywords)
    ? service.keywords.filter((word): word is string => typeof word === "string" && word !== "")
    : [];
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const text = typeof args[0] === "string" ? args[0] : "";
    const services = Array.isArray(args[1]) ? args[1] as Service[] : [];
    // The longest matching keyword wins; on a tie the earlier service in the configured order.
    let best: { service: Service; length: number } | null = null;
    for (const service of services) {
      for (const word of keywordsOf(service)) {
        if (text.startsWith(word) && (best === null || word.length > best.length)) best = { service, length: word.length };
      }
    }
    return best === null ? result === null : result === best.service;
  },
};
