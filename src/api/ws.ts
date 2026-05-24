/**
 * WebSocket broadcast endpoint (/ws).
 *
 * eventBus に乗った全 ConcordiaEvent を JSON で接続中の各 client に流す.
 * 認証なし (loopback 想定). client 側で reconnect / dedup を担当する.
 *
 * 既存 SSE (/v1/stream) と並行運用. WS は frontend SPA の即応用 / AI agent の
 * 永続クライアント (= active 判定の主軸) として使われる. URL に `?session=<id>`
 * を付けて接続すると Concordia は sessions.ws_clients をインクリメントし、
 * 切断時にデクリメントする. これにより sweeper の lost 判定から除外される.
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventBus, type ConcordiaEvent } from "../events.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("ws");
const PING_INTERVAL_MS = 25_000;

/**
 * Events with a `target_session_id` are session-scoped — only the WS clients
 * whose `?session=<id>` matches receive them. Used by `session.inject` to
 * push instructions at exactly one session without leaking to peer clients.
 */
function targetSessionId(ev: ConcordiaEvent): string | null {
  if (ev.type === "session.inject") return ev.target_session_id;
  if (ev.type === "transcript.frame") return ev.target_session_id;
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

export function attachWsServer(
  httpServer: HttpServer,
  pathName = "/ws",
  sessionsRepo?: SessionsRepo,
): WsHandle {
  const wss = new WebSocketServer({ server: httpServer, path: pathName });

  // Track per-client session id so session-scoped events (e.g. session.inject)
  // can be delivered only to the intended client. WeakMap so disconnected
  // sockets GC normally.
  const clientSession = new WeakMap<WebSocket, string | null>();

  const unsub = eventBus.subscribe((ev) => {
    const data = JSON.stringify(ev);
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
    clientSession.set(ws, sessionId);
    log.debug({ clients: wss.clients.size, sessionId }, "ws connected");
    let registered = false;
    if (sessionId && sessionsRepo) {
      try {
        const after = sessionsRepo.incrementWsClients(sessionId);
        registered = after > 0;
        log.debug({ sessionId, ws_clients: after }, "ws session registered");
      } catch (err) {
        log.warn({ err: (err as Error).message, sessionId }, "incrementWsClients failed");
      }
    }
    const hello = JSON.stringify({
      type: "hello",
      ts: Math.floor(Date.now() / 1000),
      service: "concordia",
      session_id: sessionId,
      registered,
    });
    try { ws.send(hello); } catch { /* swallow */ }

    let alive = true;
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
