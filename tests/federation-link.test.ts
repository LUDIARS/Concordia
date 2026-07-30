/**
 * 連合リンクの実ソケット統合テスト (本社 listener ⇄ 拠点クライアント)。
 * ws-session-inject.test.ts と同様に実ポート (ephemeral) で listen する。
 */

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { SecretBox } from "../src/shared/secret-box.js";
import { makeFederationSitesRepo } from "../src/db/federation-sites-repo.js";
import { makeFederationOutboxRepo } from "../src/db/federation-outbox-repo.js";
import { createFederationConnections } from "../src/federation/hq-connections.js";
import { startFederationListener, type FederationListenerHandle } from "../src/federation/hq-listener.js";
import { startFederationSiteClient, resolveHqEndpoint } from "../src/federation/site-client.js";
import { serializeFederationFrame } from "../src/federation/protocol.js";
import { makeTestDb } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

const secretBox = new SecretBox(Buffer.alloc(32, 3));

async function startHq(limits = { maxRows: 100, ttlSec: 3600 }): Promise<{
  listener: FederationListenerHandle;
  sites: ReturnType<typeof makeFederationSitesRepo>;
  outbox: ReturnType<typeof makeFederationOutboxRepo>;
  connections: ReturnType<typeof createFederationConnections>;
  url: string;
}> {
  const db = makeTestDb();
  const sites = makeFederationSitesRepo(db, secretBox);
  const outbox = makeFederationOutboxRepo(db, limits);
  const connections = createFederationConnections();
  const listener = await startFederationListener({
    host: "127.0.0.1",
    port: 0,
    sites,
    outbox,
    connections,
    hqVersion: "test-hq",
  });
  registerCleanup(() => listener.close());
  return { listener, sites, outbox, connections, url: `ws://127.0.0.1:${listener.port}/federation/ws` };
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

describe("federation link", () => {
  it("authenticates, delivers queued events in order, and drains on ack", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });

    // 切断中に積んだイベントが接続時に順序どおり届くこと。
    hq.listener.enqueue("site-a", { n: 1 });
    hq.listener.enqueue("site-a", { n: 2 });

    const received: number[] = [];
    let linkedInfo: { hqVersion: string; pendingEvents: number } | null = null;
    const client = startFederationSiteClient({
      hqUrl: hq.url,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
      onEvent: (payload) => received.push((payload as { n: number }).n),
      onLinked: (info) => { linkedInfo = info; },
    });
    registerCleanup(() => client.stop());

    await waitFor(() => received.length === 2);
    expect(received).toEqual([1, 2]);
    expect(linkedInfo).toEqual({ hqVersion: "test-hq", pendingEvents: 2 });
    expect(client.isLinked()).toBe(true);

    // ack で outbox が掃けている。
    await waitFor(() => hq.outbox.pendingCount("site-a") === 0);

    // 接続中の enqueue は即時配送。
    hq.listener.enqueue("site-a", { n: 3 });
    await waitFor(() => received.length === 3);
    expect(received).toEqual([1, 2, 3]);

    // ライブ状態が WebUI 用レジストリに反映されている。
    expect(hq.connections.get("site-a")?.siteVersion).toBe("test-site");
    expect(hq.sites.find("site-a")?.last_connected_at).not.toBeNull();
  });

  it("ignores an ack beyond what hq actually sent (no silent event loss)", async () => {
    // 1 バッチ (DELIVERY_BATCH=100) を超える分を積み、未配送分が残る状態を作る。
    const hq = await startHq({ maxRows: 1_000, ttlSec: 3600 });
    const { token } = hq.sites.create({ siteId: "site-a" });
    const total = 150;
    for (let i = 1; i <= total; i++) hq.listener.enqueue("site-a", { n: i });

    const seen: number[] = [];
    let bogusAckSent = false;
    const ws = new WebSocket(hq.url);
    registerCleanup(() => { try { ws.close(); } catch { /* ignore */ } });
    ws.on("open", () => {
      ws.send(serializeFederationFrame({ type: "hello", site_id: "site-a", token }));
    });
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { type?: string; seq?: number };
      if (frame.type !== "event" || typeof frame.seq !== "number") return;
      seen.push(frame.seq);
      // 1 バッチ受け取ったところで「全部受領した」と嘘の ack を送る。未配送の
      // 101..150 が消えてしまうなら、この後それらは永久に届かない。
      if (seen.length === 100 && !bogusAckSent) {
        bogusAckSent = true;
        ws.send(serializeFederationFrame({ type: "ack", seq: total * 10 }));
      }
    });

    await waitFor(() => seen.includes(total));
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it("drops a hq-disconnected site from the live registry immediately", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });
    const client = startFederationSiteClient({
      hqUrl: hq.url,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
    });
    registerCleanup(() => client.stop());
    await waitFor(() => hq.connections.get("site-a") !== null);

    hq.listener.disconnect("site-a", "revoked");
    // close の完了を待たない: 経路断で close が来なくても配送を止める必要がある。
    expect(hq.connections.get("site-a")).toBeNull();
  });

  it("rejects a bad token and closes with 1008", async () => {
    const hq = await startHq();
    hq.sites.create({ siteId: "site-a" });

    const ws = new WebSocket(hq.url);
    registerCleanup(() => { try { ws.close(); } catch { /* ignore */ } });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("open", () => {
      ws.send(serializeFederationFrame({ type: "hello", site_id: "site-a", token: "wrong" }));
    });
    expect(await closed).toBe(1008);
    expect(hq.connections.get("site-a")).toBeNull();
  });

  it("rejects a revoked site", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });
    hq.sites.revoke("site-a");

    const ws = new WebSocket(hq.url);
    registerCleanup(() => { try { ws.close(); } catch { /* ignore */ } });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("open", () => {
      ws.send(serializeFederationFrame({ type: "hello", site_id: "site-a", token }));
    });
    expect(await closed).toBe(1008);
  });

  it("closes an unauthenticated peer that sends an oversized frame", async () => {
    const hq = await startHq();
    hq.sites.create({ siteId: "site-a" });

    const ws = new WebSocket(hq.url);
    registerCleanup(() => { try { ws.close(); } catch { /* ignore */ } });
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    // 未認証の相手にメモリを積ませない (ws 既定の 100MB ではなく listener の上限が効く)。
    ws.on("error", () => { /* 1009 に伴う error は無視 */ });
    ws.on("open", () => {
      ws.send(serializeFederationFrame({
        type: "hello",
        site_id: "site-a",
        token: "x".repeat(64 * 1024),
      }));
    });
    expect(await closed).toBe(1009);
    expect(hq.connections.get("site-a")).toBeNull();
  });

  it("caps pending handshakes per remote so one source cannot lock everyone out", async () => {
    const hq = await startHq();
    const { token } = hq.sites.create({ siteId: "site-a" });

    // hello を送らない接続で枠を埋める (remote 上限 4)。
    const idle = Array.from({ length: 4 }, () => new WebSocket(hq.url));
    registerCleanup(() => {
      for (const ws of idle) { try { ws.close(); } catch { /* ignore */ } }
    });
    for (const ws of idle) ws.on("error", () => { /* 切断に伴う error は無視 */ });
    await Promise.all(idle.map((ws) => new Promise<void>((resolve) => ws.on("open", () => resolve()))));

    const extra = new WebSocket(hq.url);
    registerCleanup(() => { try { extra.close(); } catch { /* ignore */ } });
    extra.on("error", () => { /* ignore */ });
    const extraClosed = new Promise<number>((resolve) => extra.on("close", (code) => resolve(code)));
    expect(await extraClosed).toBe(1013);

    // 枠が空けば同じ remote からでも通常どおり認証できる。
    idle[0].close();
    const client = startFederationSiteClient({
      hqUrl: hq.url,
      siteId: "site-a",
      token,
      siteVersion: "test-site",
    });
    registerCleanup(() => client.stop());
    await waitFor(() => client.isLinked());
  });

  it("refuses plain ws:// to a non-loopback HQ", () => {
    expect(() => resolveHqEndpoint("ws://hq.example.com:4260")).toThrow(/wss/);
    expect(resolveHqEndpoint("ws://127.0.0.1:4260")).toContain("/federation/ws");
    // URL.hostname は IPv6 を "[::1]" で返すので、角括弧を剥がして loopback 判定する。
    expect(resolveHqEndpoint("ws://[::1]:4260")).toContain("/federation/ws");
    expect(resolveHqEndpoint("wss://hq.example.com/federation/ws")).toBe("wss://hq.example.com/federation/ws");
  });
});
