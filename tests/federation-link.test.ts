/**
 * 連合リンクの実ソケット統合テスト (本社 listener ⇄ 拠点クライアント)。
 * ws-session-inject.test.ts と同様に実ポート (ephemeral) で listen する。
 */

import { EventEmitter, once } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SecretBox } from "../src/shared/secret-box.js";
import { makeFederationSitesRepo } from "../src/db/federation-sites-repo.js";
import { makeFederationOutboxRepo } from "../src/db/federation-outbox-repo.js";
import { createFederationConnections } from "../src/federation/hq-connections.js";
import { startFederationListener, type FederationListenerHandle } from "../src/federation/hq-listener.js";
import { startFederationSiteClient, resolveHqEndpoint } from "../src/federation/site-client.js";
import { serializeFederationFrame, type FederationConfigSnapshot } from "../src/federation/protocol.js";
import { makeTestDb, makeTestDir } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

const secretBox = new SecretBox(Buffer.alloc(32, 3));

/**
 * link 確立時に本社から届く config-snapshot は拠点側でディスクに落ちる。
 * 既定の保存先は cwd (= リポジトリ直下) なので、テストは必ず tmp を指す
 * — でないとテスト実行が作業ツリーへファイルを残し、前回の残骸を次回の
 * 起動キャッシュとして読み込んでしまう。
 */
function testConfigCachePath(): string {
  return join(makeTestDir("concordia-federation-link-"), ".federation-config-cache.json");
}

async function startHq(
  limits = { maxRows: 100, ttlSec: 3600 },
  createConfigSnapshot?: (siteId: string) => FederationConfigSnapshot,
): Promise<{
  listener: FederationListenerHandle;
  sites: ReturnType<typeof makeFederationSitesRepo>;
  outbox: ReturnType<typeof makeFederationOutboxRepo>;
  outboxEvents: EventEmitter;
  connections: ReturnType<typeof createFederationConnections>;
  url: string;
}> {
  const db = makeTestDb();
  const sites = makeFederationSitesRepo(db, secretBox);
  const outbox = makeFederationOutboxRepo(db, limits);
  const outboxEvents = new EventEmitter();
  const connections = createFederationConnections();
  const listener = await startFederationListener({
    host: "127.0.0.1",
    port: 0,
    sites,
    outbox: {
      ...outbox,
      ackUpTo(siteId, seq) {
        const acked = outbox.ackUpTo(siteId, seq);
        if (outbox.pendingCount(siteId) === 0) outboxEvents.emit("drained", siteId);
        return acked;
      },
    },
    connections,
    hqVersion: "test-hq",
    createConfigSnapshot,
  });
  registerCleanup(() => listener.close());
  return { listener, sites, outbox, outboxEvents, connections, url: `ws://127.0.0.1:${listener.port}/federation/ws` };
}

function openPeer(url: string): WebSocket {
  const ws = new WebSocket(url);
  // Cleanup can terminate a peer before its handshake completes. Assertions use once(), which also rejects on socket errors.
  ws.on("error", () => { /* an aborted handshake during cleanup emits an error */ });
  registerCleanup(() => ws.terminate());
  return ws;
}

function sendHello(ws: WebSocket, siteId: string, token: string): void {
  ws.send(serializeFederationFrame({ type: "hello", site_id: siteId, token }));
}

describe("federation link", () => {
  it("authenticates, delivers queued events in order, and drains on ack", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });

    // 切断中に積んだイベントが接続時に順序どおり届くこと。
    hq.listener.enqueue("site-a", { n: 1 });
    hq.listener.enqueue("site-a", { n: 2 });

    const received: number[] = [];
    const events = new EventEmitter();
    const queued = once(events, "queued");
    const config = once(events, "config");
    const drained = once(hq.outboxEvents, "drained");
    let linkedInfo: { hqVersion: string; pendingEvents: number } | null = null;
    const client = startFederationSiteClient({
      hqUrl: hq.url,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
      configCachePath: testConfigCachePath(),
      onConfig: () => events.emit("config"),
      onEvent: (payload) => {
        received.push((payload as { n: number }).n);
        if (received.length === 2) events.emit("queued");
        if (received.length === 3) events.emit("live");
      },
      onLinked: (info) => { linkedInfo = info; },
    });
    registerCleanup(() => client.stop());

    await Promise.all([queued, config]);
    expect(received).toEqual([1, 2]);
    expect(linkedInfo).toEqual({ hqVersion: "test-hq", pendingEvents: 2 });
    expect(client.isLinked()).toBe(true);

    // ack で outbox が掃けている。
    expect(await drained).toEqual(["site-a"]);
    expect(hq.outbox.pendingCount("site-a")).toBe(0);

    // 接続中の enqueue は即時配送。
    const live = once(events, "live");
    hq.listener.enqueue("site-a", { n: 3 });
    await live;
    expect(received).toEqual([1, 2, 3]);

    // ライブ状態が WebUI 用レジストリに反映されている。
    expect(hq.connections.get("site-a")?.siteVersion).toBe("test-site");
    expect(hq.sites.find("site-a")?.last_connected_at).not.toBeNull();
  });

  it("delivers the current configuration on link and on explicit redistribution", async () => {
    const asked: string[] = [];
    let snapshot: FederationConfigSnapshot = { discord: { guild_id: "g1" }, templates: [] };
    const hq = await startHq({ maxRows: 100, ttlSec: 3600 }, (siteId) => {
      asked.push(siteId);
      return snapshot;
    });
    const { token } = hq.sites.create({ siteId: "site-a" });

    const events = new EventEmitter();
    const initialConfig = once(events, "config");
    const client = startFederationSiteClient({
      hqUrl: hq.url,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
      configCachePath: testConfigCachePath(),
      onConfig: (config) => events.emit("config", config),
    });
    registerCleanup(() => client.stop());

    // link 確立で本社の現在値が届く (拠点は自分では設定を組み立てない)。
    expect(await initialConfig).toEqual([{ discord: { guild_id: "g1" }, templates: [] }]);

    // 担当部署を外した後の明示再配布は、接続中の拠点へ縮んだ現在値を届ける。
    snapshot = { discord: {}, templates: [] };
    const updatedConfig = once(events, "config");
    expect(hq.listener.sendConfigUpdate("site-a")).toBe(true);
    expect(await updatedConfig).toEqual([{ discord: {}, templates: [] }]);
    expect(client.getConfig()).toEqual({ discord: {}, templates: [] });
    expect(asked).toEqual(["site-a", "site-a"]);

    // 未接続の拠点へは送れない (次回 link 時の config-snapshot で追いつく)。
    expect(hq.listener.sendConfigUpdate("site-b")).toBe(false);
  });

  it("ignores an ack beyond what hq actually sent (no silent event loss)", async () => {
    // 1 バッチ (DELIVERY_BATCH=100) を超える分を積み、未配送分が残る状態を作る。
    const hq = await startHq({ maxRows: 1_000, ttlSec: 3600 });
    const { token } = hq.sites.create({ siteId: "site-a" });
    const total = 150;
    for (let i = 1; i <= total; i++) hq.listener.enqueue("site-a", { n: i });

    const seen: number[] = [];
    const ws = openPeer(hq.url);
    await once(ws, "open");
    const receivedAll = new Promise<void>((resolve, reject) => {
      ws.once("error", reject);
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { type?: string; seq?: number };
        if (frame.type !== "event" || typeof frame.seq !== "number") return;
        seen.push(frame.seq);
        // 試験上の過大な ack を送った後も、未配送だった seq がすべて届く。
        if (seen.length === 100) ws.send(serializeFederationFrame({ type: "ack", seq: total * 10 }));
        if (frame.seq === total) resolve();
      });
    });
    sendHello(ws, "site-a", token);
    await receivedAll;
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it("drops a hq-disconnected site from the live registry immediately", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });
    const events = new EventEmitter();
    const config = once(events, "config");
    const client = startFederationSiteClient({
      hqUrl: hq.url,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
      configCachePath: testConfigCachePath(),
      onConfig: () => events.emit("config"),
    });
    registerCleanup(() => client.stop());
    await config;
    expect(hq.connections.get("site-a")).not.toBeNull();

    hq.listener.disconnect("site-a", "revoked");
    // close の完了を待たない: 経路断で close が来なくても配送を止める必要がある。
    expect(hq.connections.get("site-a")).toBeNull();
  });

  it("rejects a bad token and closes with 1008", async () => {
    const hq = await startHq();
    hq.sites.create({ siteId: "site-a" });

    const ws = openPeer(hq.url);
    await once(ws, "open");
    const rejected = Promise.all([once(ws, "message"), once(ws, "close")]);
    sendHello(ws, "site-a", "wrong");
    const [[raw], [code]] = await rejected;
    expect(JSON.parse(raw.toString())).toMatchObject({ type: "error", code: "auth_failed" });
    expect(code).toBe(1008);
    expect(hq.connections.get("site-a")).toBeNull();
  });

  it("rejects a revoked site", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });
    hq.sites.revoke("site-a");

    const ws = openPeer(hq.url);
    await once(ws, "open");
    const closed = once(ws, "close");
    sendHello(ws, "site-a", token);
    expect((await closed)[0]).toBe(1008);
  });

  it("closes an unauthenticated peer that sends an oversized frame", async () => {
    const hq = await startHq();
    hq.sites.create({ siteId: "site-a" });

    const ws = openPeer(hq.url);
    await once(ws, "open");
    const closed = once(ws, "close");
    // 未認証の相手にメモリを積ませない (ws 既定の 100MB ではなく listener の上限が効く)。
    sendHello(ws, "site-a", "x".repeat(64 * 1024));
    expect((await closed)[0]).toBe(1009);
    expect(hq.connections.get("site-a")).toBeNull();
  });

  it("caps pending handshakes per remote so one source cannot lock everyone out", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });
    const second = hq.sites.create({ siteId: "site-b" });

    // hello を送らない接続で枠を埋める (remote 上限 4)。
    const idle = Array.from({ length: 4 }, () => openPeer(hq.url));
    await Promise.all(idle.map((ws) => once(ws, "open")));

    const extra = openPeer(hq.url);
    expect((await once(extra, "close"))[0]).toBe(1013);

    // HQ は welcome を送る前に hello 待ち枠を解放する。
    const welcome = once(idle[0], "message");
    sendHello(idle[0], "site-a", token);
    expect(JSON.parse((await welcome)[0].toString())).toMatchObject({ type: "welcome" });

    const next = openPeer(hq.url);
    await once(next, "open");
    const nextWelcome = once(next, "message");
    sendHello(next, "site-b", second.token);
    expect(JSON.parse((await nextWelcome)[0].toString())).toMatchObject({ type: "welcome" });
    expect(hq.connections.get("site-b")).not.toBeNull();
  });

  it("closes pending peers on shutdown and ignores their queued hello", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });
    const ws = openPeer(hq.url);
    await once(ws, "open");

    const closed = once(ws, "close");
    sendHello(ws, "site-a", token);
    hq.listener.close();

    expect((await closed)[0]).toBe(1001);
    expect(hq.connections.get("site-a")).toBeNull();
    expect(hq.sites.find("site-a")?.last_connected_at).toBeNull();
  });

  it("refuses plain ws:// to a non-loopback HQ", () => {
    expect(() => resolveHqEndpoint("ws://hq.example.com:4260")).toThrow(/wss/);
    expect(resolveHqEndpoint("ws://127.0.0.1:4260")).toContain("/federation/ws");
    // URL.hostname は IPv6 を "[::1]" で返すので、角括弧を剥がして loopback 判定する。
    expect(resolveHqEndpoint("ws://[::1]:4260")).toContain("/federation/ws");
    expect(resolveHqEndpoint("wss://hq.example.com/federation/ws")).toBe("wss://hq.example.com/federation/ws");
  });

  // CC-FED-T1: tailnet (WireGuard で暗号化) の IP 宛ては平文 ws を許す。ホスト名と LAN は許さない。
  it("allows plain ws:// only to a tailnet IP among non-loopback HQs", () => {
    expect(resolveHqEndpoint("ws://100.122.174.105:11112")).toBe("ws://100.122.174.105:11112/federation/ws");
    expect(resolveHqEndpoint("ws://[fd7a:115c:a1e0::1]:11112")).toContain("/federation/ws");
    expect(() => resolveHqEndpoint("ws://100.128.0.1:11112")).toThrow(/wss/);
    expect(() => resolveHqEndpoint("ws://192.168.1.10:11112")).toThrow(/wss/);
    expect(() => resolveHqEndpoint("ws://hq.tail1234.ts.net:11112")).toThrow(/wss/);
  });
});
