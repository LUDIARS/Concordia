/**
 * /v1/stream — Server-Sent Events で Concordia の内部 event を流す.
 *
 * - hook wrapper / 別 process / Web UI が `curl -N` 等で購読し
 *   バックエンドの動きを near-realtime で知ることができる.
 * - 接続維持 + 死活監視のため 15 秒に 1 度 ping を流す.
 * - 接続切断は通常 (timeout / network blip) として扱い、 client 側で再接続する.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventBus } from "../events.js";

const PING_INTERVAL_MS = 15_000;

export function streamRouter(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      const id0 = Math.floor(Date.now() / 1000);
      await stream.writeSSE({
        id: String(id0),
        event: "hello",
        data: JSON.stringify({ ts: id0, service: "concordia" }),
      });

      let closed = false;
      let counter = id0;
      const unsub = eventBus.subscribe((ev) => {
        if (closed) return;
        counter += 1;
        void stream.writeSSE({
          id: String(counter),
          event: ev.type,
          data: JSON.stringify(ev),
        });
      });

      const ping = setInterval(() => {
        if (closed) return;
        counter += 1;
        void stream.writeSSE({
          id: String(counter),
          event: "ping",
          data: JSON.stringify({ ts: Math.floor(Date.now() / 1000) }),
        });
      }, PING_INTERVAL_MS);

      stream.onAbort(() => {
        closed = true;
        clearInterval(ping);
        unsub();
      });

      // 永続化 (close されるまで). 30 秒スリープでイベント駆動を維持.
      while (!closed) {
        await stream.sleep(1000);
      }
    });
  });

  return app;
}
