/**
 * 拠点側: 受信イベントの配送結果 (ack / event-rejected / 再配送) を本社へ正しく返す。
 * 本社は loopback の偽 WS サーバで、実際の本社 listener・Cr・LLM は使わない。
 */

import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { startFederationSiteClient } from "../src/federation/site-client.js";
import { serializeFederationFrame } from "../src/federation/protocol.js";
import type { EventDeliveryOutcome } from "../src/federation/security/event-outcome.js";
import { makeTestDir } from "./helpers/db.js";
import { registerCleanup } from "./helpers/cleanup.js";

interface FakeHq { url: string; frames: Array<Record<string, unknown>>; closes: number[]; connections: number }

/** 接続ごとに welcome の後、指定 seq の event を順に送る偽本社。 */
async function startFakeHq(seqs: number[]): Promise<FakeHq> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/federation/ws" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  registerCleanup(() => new Promise<void>((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(() => resolve()); }));
  const hq: FakeHq = { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, frames: [], closes: [], connections: 0 };
  wss.on("connection", (ws: WebSocket) => {
    hq.connections += 1;
    ws.on("close", (code) => hq.closes.push(code));
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      hq.frames.push(frame);
      if (frame.type !== "hello") return;
      ws.send(serializeFederationFrame({ type: "welcome", hq_version: "fake", pending_events: seqs.length }));
      for (const seq of seqs) ws.send(serializeFederationFrame({ type: "event", seq, payload: { seq } }));
    });
  });
  return hq;
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

function startSite(hq: FakeHq, onEvent: (seq: number) => EventDeliveryOutcome | void) {
  const client = startFederationSiteClient({
    hqUrl: hq.url, siteId: "site-a", token: "t", siteVersion: "test",
    configCachePath: join(makeTestDir("concordia-federation-outcome-"), ".federation-config-cache.json"),
    onEvent: (payload) => onEvent((payload as { seq: number }).seq),
  });
  registerCleanup(() => client.stop());
  return client;
}

const sent = (hq: FakeHq, type: string) => hq.frames.filter(f => f.type === type);

describe("federation site event outcome", () => {
  it("acks processed events and reports rejected ones without acking them", async () => {
    const hq = await startFakeHq([1, 2, 3]);
    startSite(hq, (seq) => (seq === 2 ? { kind: "reject", reason: "grant_mismatch" } : undefined));
    await waitFor(() => sent(hq, "ack").length === 2);
    expect(sent(hq, "ack").map(f => f.seq)).toEqual([1, 3]);
    expect(sent(hq, "event-rejected")).toEqual([expect.objectContaining({ seq: 2, reason: "grant_mismatch" })]);
  });

  it("does not ack a deferred event or anything after it, and reconnects for redelivery", async () => {
    const hq = await startFakeHq([1, 2, 3]);
    const handled: number[] = [];
    let failing = true;
    startSite(hq, (seq) => {
      handled.push(seq);
      if (seq === 2 && failing) { failing = false; return { kind: "retry", reason: "authority_unavailable" }; }
      return { kind: "ack" };
    });
    await waitFor(() => hq.closes.includes(1013));
    // 1 は処理済み。2 は一時障害で ack せず、同じ接続では 3 を処理しない。
    expect(sent(hq, "ack").map(f => f.seq)).toEqual([1]);
    expect(handled).toEqual([1, 2]);
    // 再接続後の再配送で 2 以降が処理される。
    await waitFor(() => hq.connections >= 2 && sent(hq, "ack").some(f => f.seq === 3), 8_000);
    expect(sent(hq, "event-rejected")).toEqual([]);
  }, 15_000);
});
