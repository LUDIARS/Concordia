/**
 * src/anatomia/cache-stats-client.ts — read one session's Anatomia cache slice.
 *
 * The warm `anatomia web` server (the harness supply/verify daemon) exposes
 * `GET /api/cache-stats?session=<id>` returning that session's hit tally plus an
 * estimated USD cost. Concordia's status card calls this to show, per session,
 * "how much did Anatomia's shared LLM-distillation cache help me, and what is it
 * worth". Anatomia is the data owner; Concordia only reads.
 *
 * Best-effort by design: when the server is down, unreachable, or the session
 * has no cache events yet, this returns null and the card simply omits the field.
 * Uses node:http with keep-alive off (the same Windows libuv-assert caution as
 * the Anatomia hooks) and a tight timeout so a slow/absent server never stalls a
 * card refresh.
 *
 * SRP: HTTP fetch + shape narrowing only. Rendering lives in the status card.
 */
import { request } from "node:http";

/** One session's cache slice as surfaced on the status card. */
export interface SessionCacheStats {
  hits: number;
  gets: number;
  hitRate: number;
  /** USD the cache saved this session (hits avoided). */
  savedUsd: number;
  /** USD the runnable distillations cost this session (misses). */
  spentUsd: number;
  /** "measured" from real LLM tokens, or "assumed" (stub fallback → show "~"). */
  basis: "measured" | "assumed";
}

interface RawResponse {
  enabled?: boolean;
  session?: {
    tally?: { hits?: number; gets?: number; hitRate?: number } | null;
    cost?: { savedUsd?: number; spentUsd?: number; basis?: string } | null;
  };
}

/** Base URL of the warm Anatomia server (ANATOMIA_PORT, default 4200). */
function baseUrl(): string {
  const port = process.env.ANATOMIA_PORT || "4200";
  return `http://127.0.0.1:${port}`;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Fetch the cache slice for `sessionId`. Returns null on any failure or when the
 * session has no cache events (so the caller just omits the card field).
 */
export function fetchSessionCacheStats(
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<SessionCacheStats | null> {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const url = `${baseUrl()}/api/cache-stats?session=${encodeURIComponent(sessionId)}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: SessionCacheStats | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(url);
      const req = request(
        { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", agent: false },
        (r) => {
          if (!r.statusCode || r.statusCode < 200 || r.statusCode >= 300) { r.resume(); return finish(null); }
          let data = "";
          r.setEncoding("utf8");
          r.on("data", (d) => { data += d; });
          r.on("end", () => finish(parse(data)));
        },
      );
      req.setTimeout(timeoutMs, () => { req.destroy(); finish(null); });
      req.on("error", () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

function parse(body: string): SessionCacheStats | null {
  let json: RawResponse;
  try { json = JSON.parse(body) as RawResponse; } catch { return null; }
  const tally = json.session?.tally;
  const cost = json.session?.cost;
  if (!json.enabled || !tally || num(tally.gets) === 0) return null;
  return {
    hits: num(tally.hits),
    gets: num(tally.gets),
    hitRate: num(tally.hitRate),
    savedUsd: num(cost?.savedUsd),
    spentUsd: num(cost?.spentUsd),
    basis: cost?.basis === "measured" ? "measured" : "assumed",
  };
}
