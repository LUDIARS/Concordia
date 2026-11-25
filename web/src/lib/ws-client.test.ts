// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcordiaWsClient } from "./ws-client.js";

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  readyState = FakeSocket.CONNECTING;
  close = vi.fn();

  constructor() {
    super();
    sockets.push(this);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  frame(type: "hello" | "ping") {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, ts: 1 }) }));
  }
}

const sockets: FakeSocket[] = [];
const client = new ConcordiaWsClient();

afterEach(() => {
  client.disconnect();
  sockets.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WebSocket recovery", () => {
  it("backs off repeated failures and resets when the replacement sends hello", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    client.connect();
    sockets[0]!.dispatchEvent(new Event("close"));
    vi.advanceTimersByTime(500);
    sockets[1]!.dispatchEvent(new Event("close"));
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    sockets[2]!.open();
    sockets[2]!.frame("hello");
    sockets[2]!.dispatchEvent(new Event("close"));
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(4);
  });

  it("reuses a fresh socket, replaces a stale one and ignores the old socket's callbacks", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    client.connect();
    sockets[0]!.open();
    vi.advanceTimersByTime(50_000);
    sockets[0]!.frame("ping");
    window.dispatchEvent(new Event("focus"));
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(60_001);
    window.dispatchEvent(new Event("focus"));
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    sockets[0]!.dispatchEvent(new Event("close"));
    sockets[1]!.open();
    vi.advanceTimersByTime(15_000);
    expect(sockets).toHaveLength(2);
    expect(client.isConnected()).toBe(true);
  });
});
