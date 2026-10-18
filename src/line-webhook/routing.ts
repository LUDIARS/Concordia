/**
 * イベントの振り分け (spec/feature/line-webhook-relay.md §振り分け)。
 *
 * 1 つの LINE チャネルを複数サービスで共用し、 「グループ + 言葉」 で回し先を決める。
 * 結果は「サービス × トーク」 ごとの回し先で、 Cc はそれぞれを 1 本文にして送る
 * (サービスの応答の linked / unlinked がその本文のトークを指せるように)。
 * ここは純粋な判定だけを持ち、 紐付けの記録と HTTP は呼び出し側が持つ。
 *
 * @implements spec/feature/line-webhook-relay.md — 振り分け
 */

import { unwrapPostbackData } from "./postback.js";
import { isLinkCommand, matchServiceKeyword, routingText } from "./routing-text.js";
import type { LineWebhookTarget } from "./targets.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:c060de2e */
import augurContract_9ef02c56 from './routing.contract.js'; /* augur-inject:contract-predicate:0d9a4699 */

export type LineEvent = Record<string, unknown>;

export interface LineTalk {
  /** groupId / roomId / userId。 */
  id: string;
  kind: "group" | "room" | "user";
}

export interface TalkLink {
  service: string;
  isDefault: boolean;
}

export interface LineDelivery {
  service: LineWebhookTarget;
  talk: LineTalk;
  events: LineEvent[];
  /** 「つなぐ」 を含む (応答の linked を記録する対象)。 */
  linkRequested: boolean;
}

/** つながっている全サービスへ回すイベント。 */
const TO_LINKED = new Set(["leave", "memberLeft", "memberJoined"]);
/** 全サービスへ回すイベント (挨拶)。 */
const TO_ALL = new Set(["follow", "join"]);

export function talkOf(event: LineEvent): LineTalk | null {
  const source = event.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return null;
  if (typeof source.groupId === "string" && source.groupId !== "") return { id: source.groupId, kind: "group" };
  if (typeof source.roomId === "string" && source.roomId !== "") return { id: source.roomId, kind: "room" };
  if (typeof source.userId === "string" && source.userId !== "") return { id: source.userId, kind: "user" };
  return null;
}

/**
 * services はそのチャネルの enabled のサービス (設定順)。 links はトーク ID ごとの紐付け。
 * 回し先は設定順に並べ、 各回し先のイベントは受けた順のまま。
 */
export function routeLineEvents(
  events: readonly LineEvent[],
  services: readonly LineWebhookTarget[],
  links: (talkId: string) => readonly TalkLink[],
): LineDelivery[] {
  const deliveries = new Map<string, LineDelivery>();
  const add = (service: LineWebhookTarget, talk: LineTalk, event: LineEvent, linkRequested: boolean) => {
    const key = `${service.name}\n${talk.id}`;
    const delivery = deliveries.get(key) ?? { service, talk, events: [], linkRequested: false };
    delivery.events.push(event);
    delivery.linkRequested ||= linkRequested;
    deliveries.set(key, delivery);
  };

  for (const event of events) {
    const talk = talkOf(event);
    if (!talk) continue;
    const talkLinks = links(talk.id);
    const linked = services.filter((service) => talkLinks.some((link) => link.service === service.name));
    const usual = services.find((service) => talkLinks.some((link) => link.isDefault && link.service === service.name));
    const type = String(event.type);

    if (TO_ALL.has(type)) {
      services.forEach((service) => add(service, talk, event, false));
    } else if (TO_LINKED.has(type)) {
      linked.forEach((service) => add(service, talk, event, false));
    } else if (type === "postback") {
      const postback = event.postback as Record<string, unknown> | undefined;
      const unwrapped = unwrapPostbackData(postback?.data);
      const service = unwrapped ? services.find((item) => item.name === unwrapped.service) : undefined;
      if (unwrapped && service) add(service, talk, { ...event, postback: { ...postback, data: unwrapped.data } }, false);
    } else if (type === "message" && isTextMessage(event.message)) {
      const text = routingText(event.message);
      if (isLinkCommand(text)) {
        services.forEach((service) => add(service, talk, event, true));
        continue;
      }
      const called = matchServiceKeyword(text, services) ?? usual;
      if (called) add(called, talk, event, false);
    } else if (usual) {
      // 言葉の無いその他のイベント (画像・スタンプ等) は、 そのトークのふだんの相手へ。
      add(usual, talk, event, false);
    }
  }

  const order = (delivery: LineDelivery) => services.indexOf(delivery.service);
  return [...deliveries.values()].sort((a, b) => order(a) - order(b));
}
// @ts-expect-error augur-inject
routeLineEvents = contract(routeLineEvents, { ...augurContract_9ef02c56, contractId: 'line-wh-C-9', mode: 'observe', sample: 1, where: 'src/line-webhook/routing.ts:55', rule: 'contract-wrap', id: '9ef02c56' }); /* augur-inject:contract-wrap:9ef02c56 */

/** ボットが抜けたトーク (Cc の紐付けを消す対象)。 */
export function leftTalks(events: readonly LineEvent[]): LineTalk[] {
  const talks = new Map<string, LineTalk>();
  for (const event of events) {
    const talk = event.type === "leave" ? talkOf(event) : null;
    if (talk) talks.set(talk.id, talk);
  }
  return [...talks.values()];
}

function isTextMessage(message: unknown): message is Record<string, unknown> {
  return !!message && typeof message === "object" && (message as { type?: unknown }).type === "text";
}
