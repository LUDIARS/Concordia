import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { attachWsSocketErrorHandler } from "./ws.js";

describe("WebSocket per-socket error handling", () => {
  it("captures a socket error instead of leaving an unhandled error event", () => {
    const socket = new EventEmitter();
    const report = vi.fn();
    attachWsSocketErrorHandler(socket as never, report);
    expect(() => socket.emit("error", new Error("ECONNRESET"))).not.toThrow();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "ECONNRESET" }));
  });
});
