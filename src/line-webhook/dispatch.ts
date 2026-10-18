/**
 * 回し先への転送と応答の回収 (spec/feature/line-webhook-relay.md §転送)。
 *
 * 回し先 (サービス × トーク) ごとに LINE の webhook 本文と同じ形 (`{destination, events}`) を作り直し、
 * 並行して送る。 本文を作り直すのでサービスは LINE の署名を見ない (中継トークンで Cc からの転送を確かめる)。
 * 応答の linked / unlinked はその本文のトークに対するものとして、 紐付けの記録へ反映する。
 *
 * @implements spec/feature/line-webhook-relay.md — 転送
 */

import { buildRelayHeaders } from "./relay-headers.js";
import type { RelayInput, RelayOutcome } from "./relay.js";
import { parseServiceAnswer, type LineReply } from "./replies.js";
import type { LineDelivery } from "./routing.js";
import type { LineTalkLinkStore } from "./talk-links.js";

export interface DispatchDeps {
  channel: string;
  destination: unknown;
  relay: (input: RelayInput) => Promise<RelayOutcome>;
  relayToken: (service: string) => string | null;
  talkLinks: LineTalkLinkStore;
  timeoutMs?: number;
  now: () => number;
}

export interface DispatchResult {
  delivery: LineDelivery;
  /** 2xx で応答の形が正しかった。 */
  ok: boolean;
  /** サービスの status。 送れなかった・中継トークン未設定は null。 */
  status: number | null;
  /** 失敗の理由 (ログ用。 本文は含めない)。 */
  reason: string | null;
  replies: LineReply[];
}

export async function dispatchDeliveries(
  deliveries: readonly LineDelivery[], deps: DispatchDeps,
): Promise<DispatchResult[]> {
  const results = await Promise.all(deliveries.map((delivery) => dispatchOne(delivery, deps)));
  for (const result of results) {
    if (!result.ok) continue;
    const { service, talk } = result.delivery;
    // 応答は回し先ごとに読むので、 記録は全部そろってから設定順に反映する (ふだんの相手の決まり方を一定にする)。
    if (result.delivery.linkRequested && result.linked) deps.talkLinks.link(deps.channel, talk.id, service.name, deps.now());
    if (result.unlinked) deps.talkLinks.unlink(deps.channel, talk.id, service.name);
  }
  return results.map(({ linked: _linked, unlinked: _unlinked, ...result }) => result);
}

type InternalResult = DispatchResult & { linked: boolean; unlinked: boolean };

async function dispatchOne(delivery: LineDelivery, deps: DispatchDeps): Promise<InternalResult> {
  const failed = (status: number | null, reason: string): InternalResult => ({
    delivery, ok: false, status, reason, replies: [], linked: false, unlinked: false,
  });
  const relayToken = deps.relayToken(delivery.service.name);
  // 中継トークンが無いとサービスは必ず 401 で落とすので送らない。
  if (!relayToken) return failed(null, "relay_token_not_configured");

  const body = Buffer.from(JSON.stringify({ destination: deps.destination, events: delivery.events }), "utf8");
  const outcome = await deps.relay({
    url: delivery.service.url,
    headers: buildRelayHeaders(delivery.service, relayToken, body.byteLength),
    body,
    timeoutMs: deps.timeoutMs,
  }).catch((): RelayOutcome => ({ kind: "unreachable", reason: "connect" }));
  if (outcome.kind === "unreachable") return failed(null, outcome.reason);
  if (outcome.status < 200 || outcome.status >= 300) return failed(outcome.status, "status");
  const answer = parseServiceAnswer(outcome.body);
  if (!answer) return failed(outcome.status, "invalid_answer");
  return { delivery, ok: true, status: outcome.status, reason: null, ...answer };
}
