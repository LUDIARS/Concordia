/**
 * Voluptas の AI プレイテスト感想の保存口 (`POST /api/ai-playtests/reviews`) を LAN 内から呼ぶ adapter。
 * ヘッダは `Authorization: Bearer <鍵>` と `Idempotency-Key: <runId>` の 2 つだけ。 201 / 200 の `data.review.id` を記録 ID とする。
 *
 * 鍵は戻り値・例外の文に入れない (CC-MUSE-RELAY-INV-05)。 失敗は HTTP の番号と Voluptas の error code だけ返す。
 *
 * @implements spec/feature/playtest-review-notify.md — Muse の結果の中継
 */

import type { VoluptasAttempt } from "./muse-relay-policy.js";

export const VOLUPTAS_REVIEWS_PATH = "/api/ai-playtests/reviews";
export const VOLUPTAS_TIMEOUT_MS = 15_000;

export interface VoluptasConnection {
  url: string;
  token: string;
}

/** 設定の 2 項目から接続先を作る。 どちらかが無ければ null (保存しない)。 */
export function readVoluptasConnection(input: { url: string | null; token: string | null }): VoluptasConnection | null {
  const url = input.url?.trim();
  const token = input.token?.trim();
  if (!url || !token || !/^https?:\/\//i.test(url)) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

function errorCode(body: unknown): string | null {
  const error = body !== null && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : typeof error === "string" ? error : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
}

function reviewId(body: unknown): string | null {
  const data = body !== null && typeof body === "object" ? (body as { data?: { review?: { id?: unknown } } }).data : undefined;
  const id = data?.review?.id;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

export async function saveVoluptasReview(
  connection: VoluptasConnection,
  runId: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = VOLUPTAS_TIMEOUT_MS,
): Promise<VoluptasAttempt> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${connection.url}${VOLUPTAS_REVIEWS_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "idempotency-key": runId, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // 例外の文に URL 以外の値は入らないが、 念のため鍵を含むなら伏せる。
    const name = error instanceof Error ? (error.name === "TimeoutError" ? "timeout" : error.message) : "request failed";
    return { kind: "unavailable", reason: name.split(connection.token).join("***").slice(0, 200) };
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 200 || response.status === 201) {
    const id = reviewId(payload);
    return id ? { kind: "saved", id } : { kind: "unavailable", reason: "Voluptas の応答に記録 ID がありません" };
  }
  return { kind: "rejected", status: response.status, code: errorCode(payload) };
}
