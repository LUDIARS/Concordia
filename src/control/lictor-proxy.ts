/**
 * Resolve a session's lictor sidecar port and proxy HTTP calls to it.
 *
 * Lictor publishes `lictor_port` into `session.metadata` after its sidecar
 * is bound (see Lictor wrap.ts post-startSidecar PATCH). Concordia uses
 * this to forward per-session operations — filesystem RPCs, permission
 * checks, raw keystroke inject — to the right sidecar without leaking
 * the port to the public API.
 *
 * No auth is added; both Concordia and Lictor bind loopback, so anyone
 * who can reach Concordia can already reach the loopback Lictor port
 * directly. The proxy exists for ergonomics (Web UI doesn't need to know
 * the port) not security.
 */

import type { SessionsRepo } from "../db/sessions-repo.js";

export interface LictorTarget {
  sessionId: string;
  port: number;
}

/**
 * Returns the lictor sidecar port for a session, or an error string
 * describing why it isn't reachable.
 */
export function resolveLictorTarget(
  repo: SessionsRepo,
  sessionId: string,
): LictorTarget | { error: string } {
  const s = repo.findSession(sessionId);
  if (!s) return { error: "session not found" };
  if (s.status !== "active") return { error: `session is ${s.status}` };
  if (!s.metadata) return { error: "session has no metadata — was it lictor-wrapped?" };
  let meta: { lictor_port?: unknown };
  try {
    meta = JSON.parse(s.metadata) as { lictor_port?: unknown };
  } catch {
    return { error: "session.metadata is not JSON" };
  }
  if (typeof meta.lictor_port !== "number") {
    return { error: "session.metadata.lictor_port missing (Lictor not yet PATCHed)" };
  }
  return { sessionId, port: meta.lictor_port };
}

/**
 * 既定タイムアウト。 相手は loopback の sidecar なので、 生きていれば
 * ミリ秒で返る。 長めに取る意味はなく、 むしろ死んだ相手を掴み続ける方が害になる。
 */
export const LICTOR_FETCH_TIMEOUT_MS = 10_000;

/**
 * 重い読み取り (fs/grep 等) 用。 ripgrep が大きな木を走ることがあるので
 * 既定より長く取るが、 上限は設ける。
 */
export const LICTOR_SLOW_FETCH_TIMEOUT_MS = 30_000;

/**
 * Forward an HTTP request to the session's lictor sidecar at
 * http://127.0.0.1:<port><path>. Caller supplies the path (with leading
 * slash) and standard fetch init. Throws on network error; otherwise
 * returns the raw Response so the caller can decide how to forward status
 * + body.
 *
 * タイムアウトは呼び出し側が渡さなければ既定値を必ず付ける。 これが無いと
 * undici の headersTimeout (300 秒) まで待つため、 相手の Lictor が
 * ソケットを掴んだまま死ぬと呼び出し元のハンドラが 5 分詰まる。 2026-09-20 の
 * event loop 停止では、 死んだ peer への Established が 32 本残って Cc 全体が
 * 無応答になった ([[2026-09-20-dead-peer-fetch-stalls-event-loop]])。
 */
export async function fetchFromLictor(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}${path}`;
  return fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(LICTOR_FETCH_TIMEOUT_MS),
  });
}
