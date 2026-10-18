/** @implements spec/feature/line-webhook-relay.md — 振り分け (line-wh-C-9) */
interface Delivery { service?: { name?: unknown; enabled?: unknown }; talk?: { id?: unknown }; events?: unknown }

function talkIdOf(event: unknown): unknown {
  const source = (event as { source?: Record<string, unknown> } | null)?.source;
  return source?.groupId ?? source?.roomId ?? source?.userId;
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    if (!Array.isArray(result)) return false;
    const services = Array.isArray(args[1]) ? args[1] as unknown[] : [];
    const seen = new Set<string>();
    return (result as Delivery[]).every((delivery) => {
      const key = `${String(delivery?.service?.name)}\n${String(delivery?.talk?.id)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return services.includes(delivery?.service) && delivery?.service?.enabled === true
        && Array.isArray(delivery.events) && delivery.events.length > 0
        && delivery.events.every((event) => talkIdOf(event) === delivery.talk?.id);
    });
  },
};
