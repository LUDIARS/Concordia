/**
 * WebSocket broadcast endpoint (/ws).
 *
 * eventBus に乗った全 ConcordiaEvent を JSON で接続中の各 client に流す.
 * Cc-spawned session socket は一回限り enrollment から派生した credential を要求する。
 * observer socket は read-only で、client 側が reconnect / dedup を担当する。
 *
 * WebSocket は frontend SPA の即応用 / AI agent の
 * 永続クライアント (= active 判定の主軸) として使われる. URL に `?session=<id>`
 * を付けて接続すると Concordia は sessions.ws_clients をインクリメントし、
 * 切断時にデクリメントする. これにより sweeper の lost 判定から除外される.
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventBus, type ConcordiaEvent } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { isConcordiaEventType, toWsEventFrame, toWsHelloFrame } from "../shared/event-schema.js";
import { reviveIfLost } from "./sessions/shared.js";
import { secureValuesMatch } from "../shared/secure-compare.js";

const log = createChildLogger("ws");
const PING_INTERVAL_MS = 25_000;

export function attachWsSocketErrorHandler(
  ws: Pick<WebSocket, "on">,
  report: (error: Error) => void = (error) =>
    log.warn({ err: error.message }, "ws client socket error"),
): void {
  ws.on("error", (error) => report(error));
}

/**
 * Events with a `target_session_id` are session-scoped — only the WS clients
 * whose `?session=<id>` matches receive them. Used by `session.inject` to
 * push instructions at exactly one session without leaking to peer clients.
 *
 * Only `session.inject` (a command directed AT a lictor) needs this filter.
 * Outbound data events (`transcript.frame`, `session.permission_request`)
 * are emitted BY the lictor for the dashboard to display — the dashboard's
 * WS client doesn't claim a session, so filtering by ?session= would drop
 * every frame on the floor. The dashboard filters per-session in the React
 * component (`if (ev.target_session_id !== sessionId) return;`).
 */
function targetSessionId(ev: ConcordiaEvent): string | null {
  if (ev.type === "session.inject") return ev.target_session_id;
  return null;
}

export interface WsHandle {
  close: () => void;
}

function readSessionId(req: IncomingMessage): string | null {
  const u = req.url;
  if (!u) return null;
  // pathname を含む URL を任意の base で解釈.
  const url = new URL(u, "http://localhost");
  const id = url.searchParams.get("session");
  if (!id || id.length < 1 || id.length > 128) return null;
  return id;
}

function readEnrollment(req: IncomingMessage): string {
  if (!req.url) return "";
  return new URL(req.url, "http://localhost").searchParams.get("enrollment")?.trim() ?? "";
}

/** セッション metadata が持つ enrollment。spawn 由来でなければ空、壊れていれば null。 */
function recordedSpawnId(metadata: string | null | undefined): string | null {
  if (!metadata) return "";
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (!("concordia_spawn_id" in record)) return "";
    const spawnId = record.concordia_spawn_id;
    if (typeof spawnId !== "string" || !spawnId.trim()) return null;
    return spawnId.trim();
  } catch {
    return null;
  }
}

/**
 * enrollment を要求するのは、 照合すべき秘密を実際に持つセッションだけ。
 *
 * spec/feature/trust-boundaries.md の規則は「Cc-spawned sessions」に対するもので、
 * enrollment (CONCORDIA_SPAWN_ID) は spawn したセッションにしか配られない。 それを
 * 全セッションに要求すると、 手動起動した Lictor セッションは満たしようのない条件で
 * 1008 を返され、 Lictor 側がそれを terminal 扱いにして再接続を恒久停止する。 以降
 * last_seen_at が更新されず、 生きているセッションが sweeper に lost 判定されていた
 * (Memoria #1354)。
 *
 * 秘密を持つセッションでは一致を必須にして乗っ取りを防ぎ、 持たないセッションには
 * 要求しない。 存在しないセッションの claim は従来どおり拒否する。
 */
export function sessionEnrollmentMatches(repo: SessionsRepo, sessionId: string, supplied: string): boolean {
  return classifySessionClaim(repo, sessionId, supplied) === "accepted";
}

/**
 * claim の判定結果。 拒否は 2 種類あり、 運用上の意味がまったく違う。
 *
 *  - `unknown-session`  … その id のセッション行が無い。 **認証の失敗ではなく宛先違い**。
 *    クライアントが Cc の session id (`lictor-…`) ではない何か (provider 側の
 *    transcript UUID 等) を名乗っているときに出る。 リトライしても永久に通らない。
 *  - `enrollment-mismatch` … 行はあるが spawn の秘密が合わない。 こちらは本物の
 *    認証失敗で、 乗っ取りの疑いがある。
 *
 * 2026-09-07 まで両方を "invalid enrollment" として記録していたため、
 * 前者が 43,540 件ログを埋めていても 「enrollment が壊れている」 としか読めなかった
 * (実際の原因は廃止済み agent-client が claude の transcript UUID を名乗っていたこと)。
 * 理由を分けて、 受け取った側が原因を切り分けられるようにする。
 */
export type SessionClaimVerdict = "accepted" | "unknown-session" | "enrollment-mismatch";

export function classifySessionClaim(
  repo: SessionsRepo,
  sessionId: string,
  supplied: string,
): SessionClaimVerdict {
  const row = repo.findSession(sessionId);
  if (!row) return "unknown-session";
  const expected = recordedSpawnId(row.metadata);
  // 壊れた metadata を手動セッションとみなすと、記録済み秘密の破損が認証迂回になる。
  if (expected === null) return "enrollment-mismatch";
  if (!expected) return "accepted";
  if (Boolean(supplied) && secureValuesMatch(expected, supplied)) return "accepted";
  return "enrollment-mismatch";
}

export function attachWsServer(
  httpServer: HttpServer,
  pathName = "/ws",
  sessionsRepo?: SessionsRepo,
): WsHandle {
  const wss = new WebSocketServer({ server: httpServer, path: pathName });

  // ws は server オプション指定時に httpServer の 'error' を wss へ転送する。
  // wss 側にハンドラが無いと、 その転送された 'error' (例: listen EADDRINUSE) が
  // 未捕捉となりプロセスごとクラッシュする。 ここで握って握りつぶさずログする
  // (listen エラー自体の終了処理は server.ts の server.on("error") が担う)。
  wss.on("error", (err) => {
    log.error({ err: (err as Error).message }, "ws server error");
  });

  // Track per-client session id so session-scoped events (e.g. session.inject)
  // can be delivered only to the intended client. WeakMap so disconnected
  // sockets GC normally.
  const clientSession = new WeakMap<WebSocket, string | null>();

  const unsub = eventBus.subscribe((ev) => {
    const eventType = (ev as { type?: unknown }).type;
    if (!isConcordiaEventType(eventType)) {
      log.warn({ type: eventType }, "unknown event skipped for ws broadcast");
      return;
    }
    const data = JSON.stringify(toWsEventFrame(ev));
    const target = targetSessionId(ev);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (target !== null) {
        const sid = clientSession.get(client) ?? null;
        if (sid !== target) continue;
      }
      try { client.send(data); } catch { /* swallow */ }
    }
  });

  wss.on("connection", (ws, req) => {
    const sessionId = readSessionId(req);
    if (sessionId && sessionsRepo) {
      const verdict = classifySessionClaim(sessionsRepo, sessionId, readEnrollment(req));
      if (verdict !== "accepted") {
        // 拒否する socket にも 'error' ハンドラを先に付ける。 close() 後も TCP の
        // 後始末で ECONNRESET 等が飛びうるが、 'error' が未捕捉だと EventEmitter が
        // throw してプロセスごと落ちる (wss の 'error' は server 用で socket を拾わない)。
        // 拒否経路こそリトライで最も高頻度に踏まれるため、 ここを裸にしない。
        attachWsSocketErrorHandler(ws);
        if (verdict === "unknown-session") {
          // 認証失敗ではなく宛先違い。 リトライしても永久に通らないので、 クライアントが
          // 諦められるよう理由を close reason にも載せる。
          log.warn({ sessionId }, "ws session claim rejected: no such session (id is not a Concordia session id)");
          ws.close(1008, "unknown session id");
        } else {
          log.warn({ sessionId }, "ws session claim rejected: enrollment mismatch");
          ws.close(1008, "invalid session enrollment");
        }
        return;
      }
    }
    clientSession.set(ws, sessionId);
    log.debug({ clients: wss.clients.size, sessionId }, "ws connected");
    let registered = false;
    if (sessionId && sessionsRepo) {
      try {
        const after = sessionsRepo.incrementWsClients(sessionId);
        registered = after > 0;
        log.debug({ sessionId, ws_clients: after }, "ws session registered");
        // agent-client の WS 再接続は生存の証拠。 backend 再起動 (resetAllWsClients)
        // や一時切断で lost に落ちた健全セッションをここで active へ戻す。
        if (registered) {
          const session = sessionsRepo.findSession(sessionId);
          if (session) reviveIfLost(sessionsRepo, session, Math.floor(Date.now() / 1000));
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, sessionId }, "incrementWsClients failed");
      }
    }
    const hello = JSON.stringify(toWsHelloFrame({
      ts: Math.floor(Date.now() / 1000),
      session_id: sessionId,
      registered,
    }));
    try { ws.send(hello); } catch { /* swallow */ }

    let alive = true;
    attachWsSocketErrorHandler(ws);
    ws.on("pong", () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) {
        try { ws.terminate(); } catch { /* swallow */ }
        clearInterval(ping);
        return;
      }
      alive = false;
      try { ws.ping(); } catch { /* swallow */ }
    }, PING_INTERVAL_MS);

    ws.on("close", () => {
      clearInterval(ping);
      clientSession.delete(ws);
      if (registered && sessionId && sessionsRepo) {
        try {
          const after = sessionsRepo.decrementWsClients(sessionId);
          log.debug({ sessionId, ws_clients: after }, "ws session unregistered");
        } catch (err) {
          log.warn({ err: (err as Error).message, sessionId }, "decrementWsClients failed");
        }
      }
      log.debug({ clients: wss.clients.size }, "ws closed");
    });
  });

  return {
    close: () => {
      unsub();
      wss.close();
    },
  };
}
