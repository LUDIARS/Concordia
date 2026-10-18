/**
 * LINE webhook の受け口 `POST /hooks/line/:channel` (spec/feature/line-webhook-relay.md)。
 *
 * Cc の認証 (公開ホストの SSO) と応答キャッシュを通さない唯一の経路なので、
 * buildApp はこれをそれらのミドルウェアより前に登録する。 ここで返した応答は
 * 後続のミドルウェアへ進まない。 署名はチャネルシークレットでここで検証し、 イベントを
 * 「グループ + 言葉」 でサービスへ振り分けて中継トークン付きで渡す。 LINE への返信も Cc が行う。
 *
 * @implements spec/feature/line-webhook-relay.md — 受け口
 */

import type { Context, Hono } from "hono";
import { createChildLogger } from "../shared/logger.js";
import type { LineChannelSecrets } from "./channel-secrets.js";
import { dispatchDeliveries, type DispatchResult } from "./dispatch.js";
import { mergeRepliesWithDrops } from "./merge-replies.js";
import { wrapReplyPostbacks } from "./postback.js";
import { relayLineWebhook, type RelayInput, type RelayOutcome } from "./relay.js";
import type { LineReply } from "./replies.js";
import { createLineReplySender, type LineReplySender } from "./reply-client.js";
import { leftTalks, routeLineEvents, type LineEvent } from "./routing.js";
import { verifyLineSignature } from "./signature.js";
import { MemoryLineTalkLinkStore, type LineTalkLinkStore } from "./talk-links.js";
import { channelServices, type LineWebhookTarget } from "./targets.js";

export const LINE_WEBHOOK_PATH_PREFIX = "/hooks/line";
export const MAX_LINE_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** ログに渡すのはチャネル・サービス名・status・所要時間・バイト数・件数だけ (秘密値・本文・署名・replyToken は渡さない)。 */
export interface LineWebhookLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LineWebhookDeps {
  /** サービスの登録。 要求ごとに読む (設定画面の変更を再起動なしで効かせる)。 */
  targets: () => readonly LineWebhookTarget[];
  /** チャネルの秘密値を要求ごとに読む。 無ければすべて未設定として扱う (受け口は 503)。 */
  secrets?: (channel: string) => LineChannelSecrets;
  /** サービスの中継トークン。 無いサービスへは送らない (その回し先は失敗)。 */
  relayToken?: (service: string) => string | null;
  /** トークごとの紐付け。 無ければプロセス内のメモリに持つ。 */
  talkLinks?: LineTalkLinkStore;
  /** テスト用の差し替え口。 既定は node:http(s) で送る。 */
  relay?: (input: RelayInput) => Promise<RelayOutcome>;
  /** LINE reply API の呼び出し。 テストでは実 LINE を呼ばない代役に差し替える。 */
  sendReply?: LineReplySender;
  timeoutMs?: number;
  log?: LineWebhookLog;
  now?: () => number;
}

const NO_SECRETS: LineChannelSecrets = { channelSecret: null, channelAccessToken: null };

export function registerLineWebhookRoute(app: Hono, deps: LineWebhookDeps): void {
  const resolved: ResolvedDeps = {
    ...deps,
    talkLinks: deps.talkLinks ?? new MemoryLineTalkLinkStore(),
    sendReply: deps.sendReply ?? createLineReplySender(),
    log: deps.log ?? createChildLogger("line-webhook"),
  };
  const handler = (c: Context) => handleLineWebhook(c, resolved);
  // 名前の無い要求・入れ子のパスも未登録として 404 にする (Web 画面の fallback へ落とさない)。
  app.all(LINE_WEBHOOK_PATH_PREFIX, handler);
  app.all(`${LINE_WEBHOOK_PATH_PREFIX}/*`, handler);
}

type ResolvedDeps = LineWebhookDeps & { talkLinks: LineTalkLinkStore; sendReply: LineReplySender; log: LineWebhookLog };

async function handleLineWebhook(c: Context, deps: ResolvedDeps): Promise<Response> {
  const started = Date.now();
  const channel = c.req.path.slice(LINE_WEBHOOK_PATH_PREFIX.length + 1);
  const fields: Record<string, unknown> = { channel, body_bytes: 0 };
  const respond = (response: Response): Response => {
    deps.log.info({ ...fields, status: response.status, duration_ms: Date.now() - started }, "line webhook handled");
    return response;
  };

  const services = c.req.method === "POST" ? channelServices(deps.targets(), channel) : [];
  if (services.length === 0) return respond(jsonResponse({ error: "not_found" }, 404));

  const body = await readBodyWithLimit(c.req.raw, MAX_LINE_WEBHOOK_BODY_BYTES);
  if (body === null) return respond(jsonResponse({ error: "payload_too_large" }, 413));
  fields.body_bytes = body.byteLength;

  const secrets = deps.secrets?.(channel) ?? NO_SECRETS;
  if (!secrets.channelSecret) return respond(jsonResponse({ error: "line_channel_not_configured" }, 503));
  if (!verifyLineSignature(secrets.channelSecret, body, c.req.header("x-line-signature"))) {
    return respond(jsonResponse({ error: "signature_rejected" }, 401));
  }

  const payload = readPayload(body);
  if (!payload) return respond(jsonResponse({ error: "invalid_body" }, 400));
  fields.events = payload.events.length;

  const deliveries = routeLineEvents(payload.events, services, (talkId) => deps.talkLinks.forTalk(channel, talkId));
  fields.deliveries = deliveries.length;
  const results = deliveries.length === 0 ? [] : await dispatchDeliveries(deliveries, {
    channel,
    destination: payload.destination,
    relay: deps.relay ?? relayLineWebhook,
    relayToken: (service) => deps.relayToken?.(service) ?? null,
    talkLinks: deps.talkLinks,
    timeoutMs: deps.timeoutMs,
    now: deps.now ?? Date.now,
  });
  // ボットが抜けたトークの紐付けは、 サービスへ知らせた後に消す。
  for (const talk of leftTalks(payload.events)) deps.talkLinks.clearTalk(channel, talk.id);

  fields.upstream = results.map((result) => ({ service: result.delivery.service.name, status: result.status, reason: result.reason }));
  if (results.length > 0 && !results.some((result) => result.ok)) {
    return respond(jsonResponse({ error: "upstream_failed" }, 502));
  }

  // 返信は LINE への応答を待たせない。 失敗はログだけで、 LINE への 200 は変えない。
  const replies = collectReplies(deps, channel, results);
  fields.replies = replies.length;
  void sendReplies(deps, channel, secrets.channelAccessToken, replies);
  return respond(jsonResponse({}, 200));
}

/** postback を包み、 replyToken ごとに設定順で合流する。 */
function collectReplies(deps: ResolvedDeps, channel: string, results: readonly DispatchResult[]): LineReply[] {
  const groups = results.filter((result) => result.ok).map((result) => result.replies.map((reply) => {
    const service = result.delivery.service.name;
    const wrapped = wrapReplyPostbacks(reply, service);
    if (wrapped === reply) deps.log.warn({ channel, service }, "line postback data too long to wrap; sent unwrapped");
    return wrapped;
  }));
  const merged = mergeRepliesWithDrops(groups);
  if (merged.dropped > 0) deps.log.warn({ channel, dropped: merged.dropped }, "line reply messages over the limit were dropped");
  return merged.replies;
}

async function sendReplies(
  deps: ResolvedDeps, channel: string, accessToken: string | null, replies: readonly LineReply[],
): Promise<void> {
  if (replies.length === 0) return;
  if (!accessToken) {
    deps.log.warn({ channel, replies: replies.length }, "line reply skipped: channel access token not configured");
    return;
  }
  const outcomes = await Promise.all(replies.map((reply) =>
    deps.sendReply({ accessToken, reply }).catch(() => ({ ok: false as const, status: null }))));
  for (const outcome of outcomes) {
    if (!outcome.ok) deps.log.warn({ channel, status: outcome.status }, "line reply failed");
  }
}

/** 署名を確かめた本文を読む。 events が配列でなければ null。 */
function readPayload(body: Uint8Array): { destination: unknown; events: LineEvent[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { destination, events } = value as Record<string, unknown>;
  if (!Array.isArray(events)) return null;
  const objects = events.filter((event): event is LineEvent => !!event && typeof event === "object" && !Array.isArray(event));
  return { destination, events: objects };
}

/**
 * 応答ヘッダ (cache-control: no-store 含む) は必ず Response の init で渡す。 本番の
 * @hono/node-server は軽量 Response が本文を読んだ時点で init から作り直すため、
 * 後から足したヘッダは消える (spec/feature/web-sso.md §境界と戻し方)。
 */
function jsonResponse(payload: Record<string, string | number | null>, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** 受けたバイト列をそのまま読む。 上限を超えたら読むのをやめて null。 */
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
