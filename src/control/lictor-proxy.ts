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
 * Forward an HTTP request to the session's lictor sidecar at
 * http://127.0.0.1:<port><path>. Caller supplies the path (with leading
 * slash) and standard fetch init. Throws on network error; otherwise
 * returns the raw Response so the caller can decide how to forward status
 * + body.
 */
export async function fetchFromLictor(
  port: number,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}${path}`;
  return fetch(url, init);
}
