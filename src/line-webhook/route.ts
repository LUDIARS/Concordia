/**
 * LINE webhook の受け口 `POST /hooks/line/:target` (spec/feature/line-webhook-relay.md)。
 *
 * Cc の認証 (公開ホストの SSO) と応答キャッシュを通さない唯一の経路なので、
 * buildApp はこれをそれらのミドルウェアより前に登録する。 ここで返した応答は
 * 後続のミドルウェアへ進まない。 署名は target のチャネルシークレットでここで検証し、
 * サービスには中継トークン付きで本文だけを渡す。 LINE への返信も Cc が行う。
 *
 * @implements spec/feature/line-webhook-relay.md — 受け口
 */

import type { Context, Hono } from "hono";
import { createChildLogger } from "../shared/logger.js";
import type { LineChannelSecrets } from "./channel-secrets.js";
import { buildRelayHeaders } from "./relay-headers.js";
import { relayLineWebhook, type RelayInput, type RelayOutcome } from "./relay.js";
import { parseServiceReplies, type LineReply } from "./replies.js";
import { createLineReplySender, type LineReplySender } from "./reply-client.js";
import { verifyLineSignature } from "./signature.js";
import { resolveLineWebhookTarget, type LineWebhookTarget } from "./targets.js";

export const LINE_WEBHOOK_PATH_PREFIX = "/hooks/line";
export const MAX_LINE_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** ログに渡すのは target・status・所要時間・バイト数・件数だけ (秘密値・本文・署名は渡さない)。 */
export interface LineWebhookLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LineWebhookDeps {
  /** 要求ごとに読む (設定画面の変更を再起動なしで効かせる)。 */
  targets: () => readonly LineWebhookTarget[];
  /** target の秘密値を要求ごとに読む。 無ければすべて未設定として扱う (受け口は 503)。 */
  secrets?: (target: string) => LineChannelSecrets;
  /** テスト用の差し替え口。 既定は node:http(s) で送る。 */
  relay?: (input: RelayInput) => Promise<RelayOutcome>;
  /** LINE reply API の呼び出し。 テストでは実 LINE を呼ばない代役に差し替える。 */
  sendReply?: LineReplySender;
  timeoutMs?: number;
  log?: LineWebhookLog;
}

const NO_SECRETS: LineChannelSecrets = { channelSecret: null, channelAccessToken: null, relayToken: null };

export function registerLineWebhookRoute(app: Hono, deps: LineWebhookDeps): void {
  const resolved = {
    ...deps,
    sendReply: deps.sendReply ?? createLineReplySender(),
    log: deps.log ?? createChildLogger("line-webhook"),
  };
  const handler = (c: Context) => handleLineWebhook(c, resolved);
  // 名前の無い要求・入れ子のパスも未登録として 404 にする (Web 画面の fallback へ落とさない)。
  app.all(LINE_WEBHOOK_PATH_PREFIX, handler);
  app.all(`${LINE_WEBHOOK_PATH_PREFIX}/*`, handler);
}

type ResolvedDeps = LineWebhookDeps & { sendReply: LineReplySender; log: LineWebhookLog };

async function handleLineWebhook(c: Context, deps: ResolvedDeps): Promise<Response> {
  const started = Date.now();
  const name = c.req.path.slice(LINE_WEBHOOK_PATH_PREFIX.length + 1);
  const fields: Record<string, unknown> = { target: name, body_bytes: 0 };
  const respond = (response: Response): Response => {
    deps.log.info({ ...fields, status: response.status, duration_ms: Date.now() - started }, "line webhook handled");
    return response;
  };

  const target = c.req.method === "POST" ? resolveLineWebhookTarget(deps.targets(), name) : null;
  if (!target) return respond(jsonResponse({ error: "not_found" }, 404));

  const body = await readBodyWithLimit(c.req.raw, MAX_LINE_WEBHOOK_BODY_BYTES);
  if (body === null) return respond(jsonResponse({ error: "payload_too_large" }, 413));
  fields.body_bytes = body.byteLength;

  const secrets = deps.secrets?.(target.name) ?? NO_SECRETS;
  // 中継トークンが無いとサービスは必ず 401 で落とすので、 シークレット未設定と同じく送らない。
  if (!secrets.channelSecret || !secrets.relayToken) {
    return respond(jsonResponse({ error: "line_channel_not_configured" }, 503));
  }
  if (!verifyLineSignature(secrets.channelSecret, body, c.req.header("x-line-signature"))) {
    return respond(jsonResponse({ error: "signature_rejected" }, 401));
  }

  const relay = deps.relay ?? relayLineWebhook;
  const outcome = await relay({
    url: target.url,
    headers: buildRelayHeaders(target, secrets.relayToken, body.byteLength),
    body,
    timeoutMs: deps.timeoutMs,
  });
  if (outcome.kind === "unreachable") {
    fields.upstream = outcome.reason;
    return respond(jsonResponse({ error: "upstream_failed", status: null }, 502));
  }
  fields.upstream_status = outcome.status;
  const replies = outcome.status >= 200 && outcome.status < 300 ? parseServiceReplies(outcome.body) : null;
  if (replies === null) return respond(jsonResponse({ error: "upstream_failed", status: outcome.status }, 502));
  fields.replies = replies.length;

  // 返信は LINE への応答を待たせない。 失敗はログだけで、 LINE への 200 は変えない。
  void sendReplies(deps, target.name, secrets.channelAccessToken, replies);
  return respond(jsonResponse({}, 200));
}

async function sendReplies(
  deps: ResolvedDeps, target: string, accessToken: string | null, replies: readonly LineReply[],
): Promise<void> {
  if (replies.length === 0) return;
  if (!accessToken) {
    deps.log.warn({ target, replies: replies.length }, "line reply skipped: channel access token not configured");
    return;
  }
  const outcomes = await Promise.all(replies.map((reply) =>
    deps.sendReply({ accessToken, reply }).catch(() => ({ ok: false as const, status: null }))));
  for (const outcome of outcomes) {
    if (!outcome.ok) deps.log.warn({ target, status: outcome.status }, "line reply failed");
  }
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
