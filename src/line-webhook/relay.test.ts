import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { relayLineWebhook } from "./relay.js";

async function withUpstream(
  handle: RequestListener,
  test: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handle);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    await test(`http://127.0.0.1:${address.port}/hook`);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

describe("relayLineWebhook HTTP transport", () => {
  it("sends the configured Host on the wire and reads the response body", async () => {
    await withUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(req.headers.host);
    }, async (url) => {
      const host = "mf-hook.example.test";
      const result = await relayLineWebhook({ url, headers: { host }, body: Buffer.from("{}") });
      expect(result).toEqual({
        kind: "response", status: 200, contentType: "text/plain", body: Buffer.from(host),
      });
    });
  });

  it("ends a request when its deadline expires before the upstream responds", async () => {
    let notifyRequest!: () => void;
    const requested = new Promise<void>((resolve) => { notifyRequest = resolve; });
    await withUpstream((req) => { req.resume(); notifyRequest(); }, async (url) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const response = relayLineWebhook({ url, headers: {}, body: Buffer.alloc(0), timeoutMs: 50 });
        await Promise.race([
          requested,
          response.then((outcome) => { throw new Error(`Relay completed before reaching the upstream: ${outcome.kind}`); }),
        ]);
        await vi.advanceTimersByTimeAsync(50);
        expect(await response).toEqual({ kind: "unreachable", reason: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
