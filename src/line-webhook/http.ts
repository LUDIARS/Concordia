/**
 * LINE の受け口 (webhook と push) が共有する HTTP の小道具 (spec/feature/line-webhook-relay.md §受け口)。
 *
 * @implements spec/feature/line-webhook-relay.md — 受け口
 */

/** ログに渡すのはチャネル・サービス名・status・所要時間・バイト数・件数だけ (秘密値・本文・署名・replyToken・宛先は渡さない)。 */
export interface LineWebhookLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * 応答ヘッダ (cache-control: no-store 含む) は必ず Response の init で渡す。 本番の
 * @hono/node-server は軽量 Response が本文を読んだ時点で init から作り直すため、
 * 後から足したヘッダは消える (spec/feature/web-sso.md §境界と戻し方)。
 */
export function jsonResponse(payload: Record<string, string | number | null>, status: number): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** 受けたバイト列をそのまま読む。 上限を超えたら読むのをやめて null。 */
export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<Uint8Array | null> {
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
