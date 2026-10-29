/**
 * 発言・お知らせのチャンネル振り分け (spec/feature/discord-chat-relay.md §受信 / §お知らせチャンネル、
 * DCR-INV-02 / 04 / 13)。
 *
 * Discord に依存しない。 呼び出し側が発言の場所 (チャンネル / スレッドなら親) と、
 * セッション中継 (Lictor relay) に割り当て済みかどうかの判定を渡す。
 *
 * @implements spec/feature/discord-chat-relay.md — 受信
 * @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
 */

import type { DiscordChatRelayTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:2e1ff018 */
import augurContract_aa0f543a from './routing.contract.js'; /* augur-inject:contract-predicate:9d0c5219 */
import augurContract_7e72b534 from './notice-routing.contract.js'; /* augur-inject:contract-predicate:142042cb */

export interface DiscordMessagePlace {
  /** 発言のあったチャンネル (スレッドならスレッド自身)。 */
  channelId: string;
  /** スレッドなら親チャンネル。 スレッドでなければ null。 */
  parentId: string | null;
}

export type DiscordChatRoute =
  /** channelId は target に登録したチャンネル、 threadId はスレッド内の発言のときだけ。 */
  | { kind: "relay"; target: DiscordChatRelayTarget; channelId: string; threadId: string | null }
  /** target のチャンネルだがセッション中継にも割り当て済み。 中継せずセッション中継に任せる。 */
  | { kind: "conflict"; target: DiscordChatRelayTarget }
  | { kind: "none" };

export function routeDiscordChatMessage(
  targets: readonly DiscordChatRelayTarget[],
  place: DiscordMessagePlace,
  isSessionRelayChannel: (channelId: string) => boolean,
): DiscordChatRoute {
  return routeByChannels(targets, place, isSessionRelayChannel, (target) => target.channelIds);
}
// @ts-expect-error augur-inject
routeDiscordChatMessage = contract(routeDiscordChatMessage, { ...augurContract_aa0f543a, contractId: 'dcr-C-2', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/routing.ts:26', rule: 'contract-wrap', id: 'aa0f543a' }); /* augur-inject:contract-wrap:aa0f543a */

/** お知らせのチャンネル (noticeChannelIds) で振り分ける。 重なり判定は発言と同じ (DCR-INV-13)。 */
export function routeDiscordNotice(
  targets: readonly DiscordChatRelayTarget[],
  place: DiscordMessagePlace,
  isSessionRelayChannel: (channelId: string) => boolean,
): DiscordChatRoute {
  return routeByChannels(targets, place, isSessionRelayChannel, (target) => target.noticeChannelIds);
}
// @ts-expect-error augur-inject
routeDiscordNotice = contract(routeDiscordNotice, { ...augurContract_7e72b534, contractId: 'dcr-C-6', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/routing.ts:41', rule: 'contract-wrap', id: '7e72b534' }); /* augur-inject:contract-wrap:7e72b534 */

type ChannelsOf = (target: DiscordChatRelayTarget) => readonly string[];

function routeByChannels(
  targets: readonly DiscordChatRelayTarget[],
  place: DiscordMessagePlace,
  isSessionRelayChannel: (channelId: string) => boolean,
  channelsOf: ChannelsOf,
): DiscordChatRoute {
  const owned = findOwner(targets, place, channelsOf);
  if (!owned) return { kind: "none" };
  // スレッド自身・親チャンネルのどちらかがセッション中継なら、 同じ発言を二重に処理しない。
  const overlaps = isSessionRelayChannel(place.channelId)
    || (place.parentId !== null && isSessionRelayChannel(place.parentId));
  if (overlaps) return { kind: "conflict", target: owned.target };
  return { kind: "relay", ...owned };
}

function findOwner(targets: readonly DiscordChatRelayTarget[], place: DiscordMessagePlace, channelsOf: ChannelsOf) {
  for (const target of targets) {
    if (!target.enabled) continue;
    const channels = channelsOf(target);
    if (channels.includes(place.channelId)) {
      return { target, channelId: place.channelId, threadId: null };
    }
    if (place.parentId !== null && channels.includes(place.parentId)) {
      return { target, channelId: place.parentId, threadId: place.channelId };
    }
  }
  return null;
}
