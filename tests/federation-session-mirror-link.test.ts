/**
 * 拠点のセッションを映す投稿の依頼 (SPEC-FED-SITE-SESSION-MIRROR) を実 WS の連合リンク越しに通す。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFederationSitesRepo } from "../src/db/federation-sites-repo.js";
import { makeFederationOutboxRepo } from "../src/db/federation-outbox-repo.js";
import { SecretBox } from "../src/shared/secret-box.js";
import { createFederationConnections } from "../src/federation/hq-connections.js";
import { startFederationListener } from "../src/federation/hq-listener.js";
import { startFederationSiteClient } from "../src/federation/site-client.js";
import { makeTestDb, makeTestDir } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - startedAt > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("federation session mirror over the link", () => {
  it("a site asks HQ to open a Session forum post and gets its thread back", async () => {
    const db = makeTestDb();
    const sites = makeFederationSitesRepo(db, new SecretBox(Buffer.alloc(32, 6)));
    const seen: Array<{ siteId: string; sessionId: string; title: string }> = [];
    const listener = await startFederationListener({
      host: "127.0.0.1",
      port: 0,
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 100, ttlSec: 3600 }),
      connections: createFederationConnections(),
      hqVersion: "test-hq",
      handleMirrorOpen: async (siteId, request) => {
        seen.push({ siteId, sessionId: request.session_id, title: request.title });
        return { ok: true, guildId: "111111111111111111", channelId: "555555555555555555" };
      },
    });
    registerCleanup(() => listener.close());

    const { token } = sites.create({ siteId: "site-a" });
    const client = startFederationSiteClient({
      hqUrl: `ws://127.0.0.1:${listener.port}/federation/ws`,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
      configCachePath: join(makeTestDir("concordia-federation-mirror-"), ".federation-config-cache.json"),
    });
    registerCleanup(() => client.stop());
    await waitFor(() => client.isLinked());

    const result = await client.requestMirrorOpen({ sessionId: "sess-9", title: "画面の修正", text: "映しています" });
    expect(result).toMatchObject({ ok: true, guild_id: "111111111111111111", channel_id: "555555555555555555" });
    expect(seen).toEqual([{ siteId: "site-a", sessionId: "sess-9", title: "画面の修正" }]);
  });
});
