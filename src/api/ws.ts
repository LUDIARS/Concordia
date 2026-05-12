/**
 * WebSocket broadcast endpoint (/ws).
 *
 * eventBus に乗った全 ConcordiaEvent を JSON で接続中の各 client に流す.
 * 認証なし (loopback 想定). client 側で reconnect / dedup を担当する.
 *
 * 既存 SSE (/v1/stream) と並行運用. WS は frontend SPA の即応用、 SSE は
 * curl / hook 等 stdlib clients 用.
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("ws");
const PING_INTERVAL_MS = 25_000;

export interface WsHandle {
  close: () => void;
}

export function attachWsServer(httpServer: HttpServer, path = "/ws"): WsHandle {
  const wss = new WebSocketServer({ server: httpServer, path });

  const unsub = eventBus.subscribe((ev) => {
    const data = JSON.stringify(ev);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch { /* swallow */ }
      }
    }
  });

  wss.on("connection", (ws) => {
    log.debug({ clients: wss.clients.size }, "ws connected");
    const hello = JSON.stringify({ type: "hello", ts: Math.floor(Date.now() / 1000), service: "concordia" });
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
