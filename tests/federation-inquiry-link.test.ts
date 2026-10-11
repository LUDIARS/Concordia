/**
 * 拠点間ワンショット調査 (SPEC-FED-INQUIRY) を実 WS の連合リンク越しに通す。
 * 本社 listener + 拠点クライアントの両端に inquiry service を載せ、 双方向の依頼と結果を確かめる。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFederationSitesRepo } from "../src/db/federation-sites-repo.js";
import { makeFederationOutboxRepo } from "../src/db/federation-outbox-repo.js";
import { SecretBox } from "../src/shared/secret-box.js";
import { createFederationConnections } from "../src/federation/hq-connections.js";
import { startFederationListener } from "../src/federation/hq-listener.js";
import { startFederationSiteClient, type FederationSiteClientHandle } from "../src/federation/site-client.js";
import { createInquiryService, type InquiryService } from "../src/federation/inquiry-service.js";
import type { InquiryRunner } from "../src/federation/inquiry-runner.js";
import { makeTestDb, makeTestDir } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

const quietLog = { info: () => {}, warn: () => {} };

function answer(name: string): InquiryRunner {
  return async (request) => ({ ok: true, output: `${name}:${request.origin}:${request.prompt}`, error: null, durationMs: 1 });
}

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

describe("federation inquiry over the link", () => {
  it("HQ and a site ask each other through the real WebSocket link", async () => {
    const db = makeTestDb();
    const sites = makeFederationSitesRepo(db, new SecretBox(Buffer.alloc(32, 5)));
    const connections = createFederationConnections();
    let hqService: InquiryService | null = null;
    const listener = await startFederationListener({
      host: "127.0.0.1",
      port: 0,
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 100, ttlSec: 3600 }),
      connections,
      hqVersion: "test-hq",
      handleInquiryRequest: (siteId, frame) => hqService!.onSiteRequest(siteId, frame),
      handleInquiryResult: (siteId, frame) => hqService!.onSiteResult(siteId, frame),
    });
    registerCleanup(() => listener.close());
    hqService = createInquiryService({
      role: () => ({ kind: "hq" }),
      sendToSite: (siteId, frame) => listener.send(siteId, frame),
      sendToHq: () => false,
      isActiveSite: (siteId) => sites.find(siteId)?.status === "active",
      isConnected: (siteId) => connections.get(siteId) !== null,
      runner: () => answer("hq"),
      log: quietLog,
    });

    const { token } = sites.create({ siteId: "site-a" });
    let client: FederationSiteClientHandle | null = null;
    const siteService = createInquiryService({
      role: () => ({ kind: "site", siteId: "site-a" }),
      sendToSite: () => false,
      sendToHq: (frame) => client?.send(frame) ?? false,
      isActiveSite: () => false,
      isConnected: () => false,
      runner: () => answer("site-a"),
      log: quietLog,
    });
    client = startFederationSiteClient({
      hqUrl: `ws://127.0.0.1:${listener.port}/federation/ws`,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
      configCachePath: join(makeTestDir("concordia-federation-inquiry-"), ".federation-config-cache.json"),
      onInquiryRequest: (frame) => siteService.onHqRequest(frame),
      onInquiryResult: (frame) => siteService.onHqResult(frame),
      onUnlinked: () => siteService.failAll("HQ link closed"),
    });
    registerCleanup(() => client?.stop());
    await waitFor(() => client!.isLinked());

    const fromHq = await hqService.request({ target: "site-a", prompt: "ログを見て", timeoutSec: 30 });
    expect(fromHq).toMatchObject({ ok: true, executedBy: "site-a", output: "site-a:hq:ログを見て" });

    const fromSite = await siteService.request({ target: "hq", prompt: "版は?", timeoutSec: 30 });
    expect(fromSite).toMatchObject({ ok: true, executedBy: "hq", output: "hq:site-a:版は?" });

    const unknown = await siteService.request({ target: "site-b", prompt: "x", timeoutSec: 30 });
    expect(unknown).toMatchObject({ ok: false, error: "unknown or revoked site: site-b" });
  });
});
