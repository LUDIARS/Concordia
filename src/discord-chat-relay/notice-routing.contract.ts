/** @implements spec/feature/discord-chat-relay.md — お知らせチャンネル (dcr-C-6) */
interface TargetShape { name: string; enabled: boolean; noticeChannelIds: readonly string[] }
interface PlaceShape { channelId: string; parentId: string | null }
type Route =
  | { kind: "relay"; target: { name: string }; channelId: string; threadId: string | null }
  | { kind: "conflict"; target: { name: string } }
  | { kind: "none" };

/** Restates which enabled target owns the notice's place by its noticeChannelIds, without calling the router. */
function owner(targets: readonly TargetShape[], place: PlaceShape): { name: string; channelId: string; threadId: string | null } | null {
  for (const target of targets) {
    if (!target.enabled) continue;
    const channels = Array.isArray(target.noticeChannelIds) ? target.noticeChannelIds : [];
    if (channels.includes(place.channelId)) return { name: target.name, channelId: place.channelId, threadId: null };
    if (place.parentId && channels.includes(place.parentId)) {
      return { name: target.name, channelId: place.parentId, threadId: place.channelId };
    }
  }
  return null;
}

export default {
  post(result: unknown, ...args: unknown[]): boolean {
    const targets = args[0] as readonly TargetShape[];
    const place = args[1] as PlaceShape;
    const isSessionRelayChannel = args[2] as (channelId: string) => boolean;
    if (!Array.isArray(targets) || !place || typeof isSessionRelayChannel !== "function") return false;
    const route = result as Route;
    const expected = owner(targets, place);
    if (!expected) return route?.kind === "none";
    const overlaps = isSessionRelayChannel(place.channelId) || (place.parentId !== null && isSessionRelayChannel(place.parentId));
    if (overlaps) return route?.kind === "conflict" && route.target.name === expected.name;
    return route?.kind === "relay" && route.target.name === expected.name
      && route.channelId === expected.channelId && route.threadId === expected.threadId;
  },
};
