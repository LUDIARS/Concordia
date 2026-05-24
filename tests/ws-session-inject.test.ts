// Session-targeted WS broadcast: confirms `session.inject` events are
// delivered only to the WS client whose ?session=<id> matches, and not to
// peer clients on the same /ws.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { attachWsServer, type WsHandle } from "../src/api/ws.js";
import { eventBus } from "../src/events.js";

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

    await Promise.all([
      new Promise<void>((r) => wsA.once("open", r)),
      new Promise<void>((r) => wsB.once("open", r)),
      new Promise<void>((r) => wsNone.once("open", r)),
    ]);

    const recA: any[] = [];
    const recB: any[] = [];
    const recNone: any[] = [];
    wsA.on("message", (d) => recA.push(JSON.parse(String(d))));
    wsB.on("message", (d) => recB.push(JSON.parse(String(d))));
    wsNone.on("message", (d) => recNone.push(JSON.parse(String(d))));

    // Drain initial "hello" frame.
    await new Promise((r) => setTimeout(r, 50));
    recA.length = 0; recB.length = 0; recNone.length = 0;

    eventBus.emit({
      type: "session.inject",
      target_session_id: "alpha",
      text: "hello alpha",
      source: null,
      ts: 1,
    });

    await new Promise((r) => setTimeout(r, 50));

    const injectsA = recA.filter((m) => m.type === "session.inject");
    const injectsB = recB.filter((m) => m.type === "session.inject");
    const injectsNone = recNone.filter((m) => m.type === "session.inject");

    expect(injectsA).toHaveLength(1);
    expect(injectsA[0].text).toBe("hello alpha");
    expect(injectsB).toHaveLength(0);
    expect(injectsNone).toHaveLength(0);

    wsA.close(); wsB.close(); wsNone.close();
  });

  it("non-targeted events (e.g. ping) still broadcast to all clients", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws?session=one`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?session=two`);
    await Promise.all([
      new Promise<void>((r) => ws1.once("open", r)),
      new Promise<void>((r) => ws2.once("open", r)),
    ]);
    const r1: any[] = []; const r2: any[] = [];
    ws1.on("message", (d) => r1.push(JSON.parse(String(d))));
    ws2.on("message", (d) => r2.push(JSON.parse(String(d))));
    await new Promise((r) => setTimeout(r, 50));
    r1.length = 0; r2.length = 0;

    eventBus.emit({ type: "ping", ts: 2 });
    await new Promise((r) => setTimeout(r, 50));

    expect(r1.some((m) => m.type === "ping")).toBe(true);
    expect(r2.some((m) => m.type === "ping")).toBe(true);

    ws1.close(); ws2.close();
  });
});
