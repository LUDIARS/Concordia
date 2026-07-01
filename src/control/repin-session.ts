/**
 * セッションの Lictor sidecar に `POST /v1/repin` を投げて transcript relay を
 * /clear なしで生 transcript へ束縛し直させる (stall 復帰)。
 *
 * 「📌 リアクションで relay を再束縛」 の built-in アクションが使う単一の呼び出し点。
 * lictor_port の解決は lictor-proxy に委譲し、 ここは HTTP 呼び出しと結果整形だけを持つ (SRP)。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { resolveLictorTarget, fetchFromLictor } from "./lictor-proxy.js";

export interface RepinResult {
  ok: boolean;
  /** 新たに束縛した transcript の絶対パス (取り直せたとき)。 */
  path?: string | null;
  /** 失敗理由 (lictor_port 未解決 / sidecar エラー / ネットワーク)。 */
  error?: string;
}

/** fetch 差し替え点 (テスト用)。 既定は lictor-proxy の fetchFromLictor。 */
export type LictorFetch = (port: number, path: string, init?: RequestInit) => Promise<Response>;

/**
 * session の Lictor へ /v1/repin を投げる。 lictor_port 未解決 (非 Lictor / 未 PATCH /
 * 非 active) や sidecar エラーは error 文字列で返す (例外は投げない)。
 */
export async function repinSession(
  repo: SessionsRepo,
  sessionId: string,
  fetchImpl: LictorFetch = fetchFromLictor,
): Promise<RepinResult> {
  const target = resolveLictorTarget(repo, sessionId);
  if ("error" in target) return { ok: false, error: target.error };
  try {
    const res = await fetchImpl(target.port, "/v1/repin", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      path?: string | null;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: body.error ?? `lictor returned ${res.status}` };
    return { ok: body.ok ?? false, path: body.path ?? null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
