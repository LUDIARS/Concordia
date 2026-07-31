import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { makeTestDir } from "../../tests/helpers/db.js";
import { readFederationConfigCache, writeFederationConfigCache } from "./config-cache.js";
import { serializeFederationFrame, type FederationConfigSnapshot } from "./protocol.js";
import { startFederationSiteClient } from "./site-client.js";

const cached: FederationConfigSnapshot = {
  discord: { guild_id: "cached-guild", session_forum_id: "cached-forum" },
  templates: [],
};

const cachePath = (): string =>
  join(makeTestDir("concordia-federation-cache-"), ".federation-config-cache.json");

describe("federation configuration cache", () => {
  it("persists the received value and reloads it after restart", () => {
    const path = cachePath();

    writeFederationConfigCache(path, cached);

    expect(readFederationConfigCache(path)).toEqual(cached);
  });

  it("site client replaces the cached value after the link is established", async () => {
    const path = cachePath();
    writeFederationConfigCache(path, cached);
    const received: FederationConfigSnapshot[] = [];
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a port");
    const fresh: FederationConfigSnapshot = { discord: { guild_id: "fresh-guild" }, templates: [] };
    server.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(serializeFederationFrame({ type: "welcome", hq_version: "test", pending_events: 0 }));
        socket.send(serializeFederationFrame({ type: "config-snapshot", snapshot: fresh }));
      });
    });
    const client = startFederationSiteClient({
      hqUrl: `ws://127.0.0.1:${address.port}`,
      siteId: "site-a",
      token: "test-credential",
      siteVersion: "test",
      configCachePath: path,
      onConfig: (config) => received.push(config),
    });
    try {
      await waitFor(() => received.length === 2);
      expect(received).toEqual([cached, fresh]);
      expect(readFederationConfigCache(path)).toEqual(fresh);
      expect(client.getConfig()).toEqual(fresh);
    } finally {
      client.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for federation configuration");
}
