import { describe, expect, it } from "vitest";
import { parseWsFrame } from "../shared/event-schema.js";
import { toWsObserverHeartbeat } from "./ws-observer-heartbeat.js";

describe("WebSocket observer heartbeat", () => {
  it("uses the existing versioned ping frame for read-only observers", () => {
    expect(parseWsFrame(toWsObserverHeartbeat(null, 123))).toEqual({
      ok: true, frame: { v: 1, type: "ping", ts: 123 },
    });
  });

  it("leaves session clients on the native ping/pong path", () => {
    expect(toWsObserverHeartbeat("session-1", 123)).toBeNull();
  });
});
