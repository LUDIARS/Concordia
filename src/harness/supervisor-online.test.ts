import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { classifyGateWait, queryGate } from "./supervisor-online.js";

const LIMITS = { softMs: 50, hardMs: 400, healthMs: 100 };
let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** Fake Cc: gate answers after `gateDelayMs` (never if null); /health answers when `healthy`. */
async function fakeCc(gateDelayMs: number | null, healthy: boolean): Promise<number> {
  server = createServer((req, res) => {
    if (req.url === "/health") {
      if (healthy) res.end(JSON.stringify({ ok: true }));
      return;
    }
    req.resume();
    if (gateDelayMs === null) return;
    setTimeout(() => res.end(JSON.stringify({ decision: "allow", blocked: false, reason: "", hits: [] })), gateDelayMs);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return (server.address() as AddressInfo).port;
}

describe("classifyGateWait", () => {
  it("never reports offline while /health answered", () => {
    expect(classifyGateWait(null, true)).toEqual({ kind: "slow" });
    expect(classifyGateWait(null, false)).toEqual({ kind: "offline" });
    expect(classifyGateWait({ status: 200, body: {} }, false).kind).toBe("online");
  });
});

describe("queryGate", () => {
  it("returns a fast gate answer without probing health", async () => {
    const port = await fakeCc(0, false);
    expect((await queryGate(port, {}, LIMITS)).kind).toBe("online");
  });

  it("keeps waiting past the soft limit while Cc is alive but slow", async () => {
    const port = await fakeCc(150, true);
    const outcome = await queryGate(port, {}, LIMITS);
    expect(outcome.kind).toBe("online");
  });

  it("stops at the hard limit and reports slow, not offline", async () => {
    const port = await fakeCc(null, true);
    const started = Date.now();
    expect(await queryGate(port, {}, LIMITS)).toEqual({ kind: "slow" });
    expect(Date.now() - started).toBeLessThan(LIMITS.hardMs + 300);
  });

  it("gives up at the soft limit when /health does not answer", async () => {
    const port = await fakeCc(null, false);
    const started = Date.now();
    expect(await queryGate(port, {}, LIMITS)).toEqual({ kind: "offline" });
    expect(Date.now() - started).toBeLessThan(LIMITS.hardMs);
  });

  it("reports offline when nothing listens", async () => {
    const port = await fakeCc(0, true);
    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;
    expect(await queryGate(port, {}, LIMITS)).toEqual({ kind: "offline" });
  });
});
