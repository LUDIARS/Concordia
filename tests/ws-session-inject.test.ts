// Session-targeted WS broadcast: confirms `session.inject` events are
// delivered only to the WS client whose ?session=<id> matches, and not to
// peer clients on the same /ws.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachWsServer, type WsHandle } from "../src/api/ws.js";
import { eventBus } from "../src/events.js";

/**
 * WS クライアントのメッセージをバッファリングし、event-driven で次の1件を返す。
 * バッファに既にメッセージが溜まっていれば即 resolve する。
 */
function makeWsReader(ws: WebSocket) {
  const buf: string[] = [];
  const waiting: Array<(msg: string) => void> = [];

  ws.on("message", (d) => {
    const msg = String(d);
    const cb = waiting.shift();
    if (cb) {
      cb(msg);
    } else {
      buf.push(msg);
    }
  });

  function next(timeoutMs = 2000): Promise<string> {
    if (buf.length > 0) return Promise.resolve(buf.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = waiting.indexOf(resolve);
        if (idx >= 0) waiting.splice(idx, 1);
        reject(new Error("ws message timeout"));
      }, timeoutMs);
      waiting.push((msg) => { clearTimeout(t); resolve(msg); });
    });
  }

  /** バッファに溜まっている全メッセージを取り出す（不在アサート用）。 */
  function drain(): string[] {
    const all = buf.slice();
    buf.length = 0;
    return all;
  }

  return { next, drain };
}

describe("ws session-targeted broadcast", () => {
  let httpServer: Server;
  let wsHandle: WsHandle;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    wsHandle = attachWsServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    port = addr.port;
  });

  afterEach(async () => {
    wsHandle.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("session.inject is only delivered to the matching session's WS client", async () => {
    const wsA = new WebSocket(`ws://127.0.0.1:${port}/ws?session=alpha`);
    const wsB = new WebSocket(`ws://127.0.0.1:${port}/ws?session=beta`);
    const wsNone = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    // リスナを open 前に登録してメッセージを取りこぼさない
    const readerA = makeWsReader(wsA);
    const readerB = makeWsReader(wsB);
    const readerNone = makeWsReader(wsNone);

    try {
      await Promise.all([
        new Promise<void>((r) => wsA.once("open", r)),
        new Promise<void>((r) => wsB.once("open", r)),
        new Promise<void>((r) => wsNone.once("open", r)),
      ]);

      // Drain initial versioned "hello" frame from all sockets concurrently
      const hellos = await Promise.all([readerA.next(), readerB.next(), readerNone.next()]);
      expect(hellos.map((m) => JSON.parse(m).v)).toEqual([1, 1, 1]);

      eventBus.emit({
        type: "session.inject",
        target_session_id: "alpha",
        text: "hello alpha",
        source: null,
        ts: 1,
      });

      // wsA の受信を event-driven で待ち、配送完了の同期点とする
      const raw = await readerA.next();
      const msgA = JSON.parse(raw);

      expect(msgA.type).toBe("session.inject");
      expect(msgA.v).toBe(1);
      expect(msgA.text).toBe("hello alpha");

      // 配送完了後に不在側のバッファを確認
      const injectsB = readerB.drain().filter((m) => JSON.parse(m).type === "session.inject");
      const injectsNone = readerNone.drain().filter((m) => JSON.parse(m).type === "session.inject");
      expect(injectsB).toHaveLength(0);
      expect(injectsNone).toHaveLength(0);
    } finally {
      wsA.close(); wsB.close(); wsNone.close();
    }
  });

  it("non-targeted events (e.g. ping) still broadcast to all clients", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?session=one`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?session=two`);

    const reader1 = makeWsReader(ws1);
    const reader2 = makeWsReader(ws2);

    try {
      await Promise.all([
        new Promise<void>((r) => ws1.once("open", r)),
        new Promise<void>((r) => ws2.once("open", r)),
      ]);

      // Drain initial versioned "hello" frame from all sockets concurrently
      await Promise.all([reader1.next(), reader2.next()]);

      eventBus.emit({ type: "ping", ts: 2 });

      // event-driven で両方の受信を待つ
      const [msg1, msg2] = await Promise.all([reader1.next(), reader2.next()]);

      expect(JSON.parse(msg1)).toMatchObject({ type: "ping", v: 1 });
      expect(JSON.parse(msg2)).toMatchObject({ type: "ping", v: 1 });
    } finally {
      ws1.close(); ws2.close();
    }
  });

  it("skips unknown events and continues broadcasting known ones", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const reader1 = makeWsReader(ws1);

    try {
      await new Promise<void>((r) => ws1.once("open", r));
      await reader1.next();

      eventBus.emit({ type: "unknown.event", ts: 3 } as never);
      eventBus.emit({ type: "ping", ts: 4 });

      const msg = JSON.parse(await reader1.next());
      expect(msg).toMatchObject({ type: "ping", ts: 4, v: 1 });
    } finally {
      ws1.close();
    }
  });
});
