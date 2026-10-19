/**
 * サービスから LINE のトークへ送る口 `POST /hooks/line/:channel/push/:service`
 * (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * webhook の受け口と同じリスナー・同じ公開経路に載る (SSO を通さない)。 認証はサービスごとの push トークン。
 * 送り先はそのチャネルでそのサービスを「ふだんの相手」 にしているトーク全部で、 LINE push API を
 * チャネルアクセストークンで呼ぶ。 判定の順は 404 → 503 (トークン未発行) → 401 → 403 (push 無効) → 413 / 400
 * → (同じ requestId なら前回の結果) → 503 (チャネルアクセストークン未設定) → 429 → 送信。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

import type { Context } from "hono";
import type { LineChannelSecrets } from "./channel-secrets.js";
import { jsonResponse, readBodyWithLimit, type LineWebhookLog } from "./http.js";
import { createLinePushSender, type LinePushSender } from "./push-client.js";
import { PushLedger, type PushResult } from "./push-limits.js";
import { selectPushTalks } from "./push-recipients.js";
import { parsePushRequest, type PushRequest } from "./push-request.js";
import { derivePushRetryKey } from "./push-retry-key.js";
import { matchPushToken } from "./push-token.js";
import type { LineTalkLinkStore } from "./talk-links.js";
import { channelServices, type LineWebhookTarget } from "./targets.js";

/** 本文は 3 件 × 1000 字に収まるので小さく取る。 */
export const MAX_LINE_PUSH_BODY_BYTES = 64 * 1024;

export interface LinePushOptions {
  /** サービスの push トークンの SHA-256 (hex)。 未発行なら null (503)。 */
  tokenHash?: (service: string) => string | null;
  /** サービスの pushEnabled。 既定は無効 (403)。 */
  enabled?: (service: string) => boolean;
  /** LINE push API の呼び出し。 テストでは実 LINE を呼ばない代役に差し替える。 */
  sendPush?: LinePushSender;
  /** 送信上限と requestId の記憶。 無ければプロセス内に 1 つ作る。 */
  ledger?: PushLedger;
}

export interface LinePushHandlerDeps extends LinePushOptions {
  targets: () => readonly LineWebhookTarget[];
  secrets?: (channel: string) => LineChannelSecrets;
  talkLinks: LineTalkLinkStore;
  log: LineWebhookLog;
  now?: () => number;
}

export function createLinePushHandler(deps: LinePushHandlerDeps): (c: Context) => Promise<Response> {
  const resolved = {
    ...deps,
    sendPush: deps.sendPush ?? createLinePushSender(),
    ledger: deps.ledger ?? new PushLedger(),
    now: deps.now ?? Date.now,
  };
  return (c) => handleLinePush(c, resolved);
}

type ResolvedPushDeps = LinePushHandlerDeps & { sendPush: LinePushSender; ledger: PushLedger; now: () => number };

async function handleLinePush(c: Context, deps: ResolvedPushDeps): Promise<Response> {
  const started = Date.now();
  const channel = c.req.param("channel") ?? "";
  const service = c.req.param("service") ?? "";
  const fields: Record<string, unknown> = { channel, service };
  const respond = (response: Response): Response => {
    deps.log.info({ ...fields, status: response.status, duration_ms: Date.now() - started }, "line push handled");
    return response;
  };

  // 登録済みで有効なサービスで、 そのチャネルに属するものだけ。
  if (!channelServices(deps.targets(), channel).some((target) => target.name === service)) {
    return respond(jsonResponse({ error: "not_found" }, 404));
  }
  const tokenHash = deps.tokenHash?.(service) ?? null;
  if (!tokenHash) return respond(jsonResponse({ error: "push_token_not_configured" }, 503));
  if (!matchPushToken(tokenHash, c.req.header("authorization"))) {
    return respond(jsonResponse({ error: "push_token_rejected" }, 401));
  }
  if (!(deps.enabled?.(service) ?? false)) return respond(jsonResponse({ error: "push_disabled" }, 403));

  const body = await readBodyWithLimit(c.req.raw, MAX_LINE_PUSH_BODY_BYTES);
  if (body === null) return respond(jsonResponse({ error: "payload_too_large" }, 413));
  const request = parsePushRequest(readJson(body));
  if (!request) return respond(jsonResponse({ error: "invalid_body" }, 400));

  const now = deps.now();
  const memoKey = [channel, service, request.requestId].join("\n");
  const previous = deps.ledger.recall(memoKey, now);
  if (previous) {
    fields.replayed = true;
    return respond(resultResponse(fields, await previous));
  }

  const accessToken = (deps.secrets?.(channel))?.channelAccessToken ?? null;
  if (!accessToken) return respond(jsonResponse({ error: "line_channel_not_configured" }, 503));
  if (!deps.ledger.take(service, now)) return respond(jsonResponse({ error: "rate_limited" }, 429));

  const talks = selectPushTalks(deps.talkLinks.list(), channel, service);
  fields.talks = talks.length;
  const result = pushToTalks(deps, channel, service, accessToken, request, talks, fields);
  deps.ledger.remember(memoKey, now, result);
  return respond(resultResponse(fields, await result));
}

/** トークごとに並行で送る。 再送はしない。 ログには失敗の status だけを残す (宛先 ID は出さない)。 */
async function pushToTalks(
  deps: ResolvedPushDeps,
  channel: string,
  service: string,
  accessToken: string,
  request: PushRequest,
  talks: readonly string[],
  fields: Record<string, unknown>,
): Promise<PushResult> {
  const outcomes = await Promise.all(talks.map((to) => deps.sendPush({
    accessToken,
    to,
    texts: request.texts,
    retryKey: derivePushRetryKey(channel, service, request.requestId, to),
  }).catch(() => ({ ok: false as const, status: null }))));
  const failures = outcomes.flatMap((outcome) => outcome.ok ? [] : [outcome.status]);
  if (failures.length > 0) fields.failed_statuses = failures;
  return { sent: outcomes.length - failures.length, failed: failures.length };
}

function resultResponse(fields: Record<string, unknown>, result: PushResult): Response {
  fields.sent = result.sent;
  fields.failed = result.failed;
  return jsonResponse({ sent: result.sent, failed: result.failed }, 200);
}

function readJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
}
