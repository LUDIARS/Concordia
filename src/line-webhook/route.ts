/**
 * LINE webhook の受け口 `POST /hooks/line/:target` (spec/feature/line-webhook-relay.md)。
 *
 * Cc の認証 (公開ホストの SSO) と応答キャッシュを通さない唯一の経路なので、
 * buildApp はこれをそれらのミドルウェアより前に登録する。 ここで返した応答は
 * 後続のミドルウェアへ進まない。 署名の検証はしない (channel secret はサービス側が正本)。
 *
 * @implements spec/feature/line-webhook-relay.md — 受け口
 */

import type { Context, Hono } from "hono";
import { createChildLogger } from "../shared/logger.js";
import { buildRelayHeaders } from "./relay-headers.js";
import { relayLineWebhook, type RelayInput, type RelayOutcome } from "./relay.js";
import { resolveLineWebhookTarget, type LineWebhookTarget } from "./targets.js";

const log = createChildLogger("line-webhook");
export const LINE_WEBHOOK_PATH_PREFIX = "/hooks/line";
export const MAX_LINE_WEBHOOK_BODY_BYTES = 1024 * 1024;
/**
 * 応答ヘッダ (cache-control: no-store 含む) は必ず Response の init で渡す。 本番の
 * @hono/node-server は軽量 Response が本文を読んだ時点で init から作り直すため、
 * 後から足したヘッダは消える (spec/feature/web-sso.md §境界と戻し方)。
 */
/** 本文を持てない status。 これらに本文付きの Response を作ると例外になる。 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

export interface LineWebhookDeps {
  /** 要求ごとに読む (設定画面の変更を再起動なしで効かせる)。 */
  targets: () => readonly LineWebhookTarget[];
  /** テスト用の差し替え口。 既定は node:http(s) で送る。 */
  relay?: (input: RelayInput) => Promise<RelayOutcome>;
  timeoutMs?: number;
}

export function registerLineWebhookRoute(app: Hono, deps: LineWebhookDeps): void {
  const handler = (c: Context) => handleLineWebhook(c, deps);
  // 名前の無い要求・入れ子のパスも未登録として 404 にする (Web 画面の fallback へ落とさない)。
  app.all(LINE_WEBHOOK_PATH_PREFIX, handler);
  app.all(`${LINE_WEBHOOK_PATH_PREFIX}/*`, handler);
}

async function handleLineWebhook(c: Context, deps: LineWebhookDeps): Promise<Response> {
  const started = Date.now();
  const name = c.req.path.slice(LINE_WEBHOOK_PATH_PREFIX.length + 1);
  let bodyBytes = 0;
  const respond = (response: Response): Response => {
    // 本文と署名は残さない (target・status・所要時間・本文バイト数だけ)。
    log.info({ target: name, status: response.status, duration_ms: Date.now() - started, body_bytes: bodyBytes },
      "line webhook relayed");
    return response;
  };

  const target = c.req.method === "POST" ? resolveLineWebhookTarget(deps.targets(), name) : null;
  if (!target) return respond(jsonResponse({ error: "not_found" }, 404));

  const body = await readBodyWithLimit(c.req.raw, MAX_LINE_WEBHOOK_BODY_BYTES);
  if (body === null) return respond(jsonResponse({ error: "payload_too_large" }, 413));
  bodyBytes = body.byteLength;

  const relay = deps.relay ?? relayLineWebhook;
  const outcome = await relay({
    url: target.url,
    headers: buildRelayHeaders((header) => c.req.header(header), target, body.byteLength),
    body,
    timeoutMs: deps.timeoutMs,
  });
  if (outcome.kind === "unreachable") {
    return respond(jsonResponse({ error: "upstream_unreachable", reason: outcome.reason }, 502));
  }
  return respond(relayedResponse(outcome));
}

/** 転送先のステータスと本文をそのまま返す (LINE の検証ボタンが本当の結果を見られるように)。 */
function relayedResponse(outcome: Extract<RelayOutcome, { kind: "response" }>): Response {
  if (outcome.status < 200 || outcome.status > 599) {
    return jsonResponse({ error: "upstream_invalid_status" }, 502);
  }
  const headers = new Headers({ "cache-control": "no-store" });
  if (outcome.contentType) headers.set("content-type", outcome.contentType);
  const body = NULL_BODY_STATUSES.has(outcome.status) ? null : new Uint8Array(outcome.body);
  return new Response(body, { status: outcome.status, headers });
}

function jsonResponse(payload: Record<string, string>, status: number): Response {
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
