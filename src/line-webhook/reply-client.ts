/**
 * LINE reply API の呼び出し (spec/feature/line-webhook-relay.md §サービスの応答と LINE への返信)。
 *
 * 受け口からは差し替え可能な関数として渡し、 テストでは実 LINE を呼ばない。
 * 失敗は投げずに結果で返す (呼び出し側はログだけ残し、 LINE への 200 は変えない)。
 *
 * @implements spec/feature/line-webhook-relay.md — サービスの応答と LINE への返信
 */

import type { LineReply } from "./replies.js";

export const LINE_REPLY_API_URL = "https://api.line.me/v2/bot/message/reply";
const REPLY_TIMEOUT_MS = 5_000;

export interface LineReplyRequest {
  accessToken: string;
  reply: LineReply;
}

export type LineReplyOutcome = { ok: true } | { ok: false; status: number | null };

export type LineReplySender = (request: LineReplyRequest) => Promise<LineReplyOutcome>;

export function createLineReplySender(options: { url?: string; fetchImpl?: typeof fetch } = {}): LineReplySender {
  const url = options.url ?? LINE_REPLY_API_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async ({ accessToken, reply }) => {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ replyToken: reply.replyToken, messages: reply.messages }),
        signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
      });
      // 本文 (エラー詳細にメッセージが混ざることがある) は読み捨てる。
      await res.body?.cancel().catch(() => undefined);
      return res.ok ? { ok: true } : { ok: false, status: res.status };
    } catch {
      return { ok: false, status: null };
    }
  };
}
