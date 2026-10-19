/**
 * LINE push API の呼び出し (spec/feature/line-webhook-relay.md §LINE push の受け口)。
 *
 * 受け口からは差し替え可能な関数として渡し、 テストでは実 LINE を呼ばない。 再送はしない
 * (429 = 月間上限などもそのまま失敗として返す)。 LINE は受理済みの `X-Line-Retry-Key` に 409 を返すので、
 * 409 は「前に送れている」 として成功に数える。 失敗は投げずに結果で返す。
 *
 * @implements spec/feature/line-webhook-relay.md — LINE push の受け口
 */

export const LINE_PUSH_API_URL = "https://api.line.me/v2/bot/message/push";
const PUSH_TIMEOUT_MS = 5_000;

export interface LinePushRequest {
  accessToken: string;
  to: string;
  texts: readonly string[];
  retryKey: string;
}

export type LinePushOutcome = { ok: true } | { ok: false; status: number | null };

export type LinePushSender = (request: LinePushRequest) => Promise<LinePushOutcome>;

export function createLinePushSender(options: { url?: string; fetchImpl?: typeof fetch } = {}): LinePushSender {
  const url = options.url ?? LINE_PUSH_API_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async ({ accessToken, to, texts, retryKey }) => {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          "x-line-retry-key": retryKey,
        },
        body: JSON.stringify({ to, messages: texts.map((text) => ({ type: "text", text })) }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      // 本文 (エラー詳細に宛先やメッセージが混ざることがある) は読み捨てる。
      await res.body?.cancel().catch(() => undefined);
      return res.ok || res.status === 409 ? { ok: true } : { ok: false, status: res.status };
    } catch {
      return { ok: false, status: null };
    }
  };
}
