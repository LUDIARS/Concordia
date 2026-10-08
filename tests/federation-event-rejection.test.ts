/**
 * 本社側: 拠点の event-rejected を ack 扱いにせず退避表へ移す (spec/feature/cc-workload-security.md「配送結果の区別」)。
 */

import { describe, expect, it, vi } from "vitest";
import { makeFederationOutboxRepo } from "../src/db/federation-outbox-repo.js";
import { makeFederationRejectedEventsRepo } from "../src/db/federation-rejected-events-repo.js";
import { rejectedEventSummary, settleRejectedEvent } from "../src/federation/event-rejection.js";
import { makeTestDb } from "./helpers/db.js";

function setup() {
  const db = makeTestDb();
  const outbox = makeFederationOutboxRepo(db, { maxRows: 100, ttlSec: 3600 });
  const rejectedEvents = makeFederationRejectedEventsRepo(db, () => 1_000);
  return { db, outbox, rejectedEvents };
}

const spawn = { type: "spawn", guild_id: "g1", channel_id: "c1", title: "secret title", body: "secret body" };

describe("federation event rejection (hq)", () => {
  it("moves a rejected in-flight request to the rejected table and keeps later requests", () => {
    const { outbox, rejectedEvents } = setup();
    const first = outbox.enqueue("site-a", spawn).seq;
    const second = outbox.enqueue("site-a", { ...spawn, channel_id: "c2" }).seq;
    const report = vi.fn();
    const result = settleRejectedEvent({ siteId: "site-a", seq: first, reason: "grant_mismatch",
      inFlight: [first, second], rejectedEvents, report });
    expect(result).toEqual({ status: "settled", inFlight: [second], retained: true });
    expect(outbox.listPending("site-a", 0, 10).map(r => r.seq)).toEqual([second]);
    expect(rejectedEvents.list("site-a")).toEqual([expect.objectContaining({ seq: first, reason: "grant_mismatch", rejected_at: 1_000 })]);
    // 通知に本文を出さない。
    const [message, detail] = report.mock.calls[0];
    expect(detail).toEqual({ site_id: "site-a", seq: first, reason: "grant_mismatch", kind: "spawn", guild_id: "g1", channel_id: "c1" });
    expect(JSON.stringify([message, detail])).not.toContain("secret");
    // 後続の累積 ack は退避済みの行に触れない。
    outbox.ackUpTo("site-a", second);
    expect(rejectedEvents.list("site-a")).toHaveLength(1);
  });

  it("ignores a rejection for a seq hq has not sent on this connection", () => {
    const { outbox, rejectedEvents } = setup();
    const seq = outbox.enqueue("site-a", spawn).seq;
    const report = vi.fn();
    expect(settleRejectedEvent({ siteId: "site-a", seq, reason: "replay", inFlight: [], rejectedEvents, report }))
      .toEqual({ status: "ignored" });
    expect(outbox.pendingCount("site-a")).toBe(1);
    expect(rejectedEvents.list()).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });

  it("still reports without a rejected table and leaves the request in the outbox", () => {
    const { outbox } = setup();
    const seq = outbox.enqueue("site-a", spawn).seq;
    const report = vi.fn();
    expect(settleRejectedEvent({ siteId: "site-a", seq, reason: "handler_failed", inFlight: [seq], report }))
      .toEqual({ status: "settled", inFlight: [], retained: false });
    expect(outbox.pendingCount("site-a")).toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("returns null when the outbox row is already gone and never duplicates a rejected row", () => {
    const { outbox, rejectedEvents } = setup();
    const seq = outbox.enqueue("site-a", spawn).seq;
    expect(rejectedEvents.moveFromOutbox("site-a", seq, "replay")).not.toBeNull();
    expect(rejectedEvents.moveFromOutbox("site-a", seq, "replay")).toBeNull();
    expect(rejectedEvents.list()).toHaveLength(1);
  });

  it("summarises only kind and thread ids, tolerating malformed payloads", () => {
    expect(rejectedEventSummary(JSON.stringify({ type: "ingress", guild_id: "g", channel_id: "c", text: "x" })))
      .toEqual({ kind: "ingress", guild_id: "g", channel_id: "c" });
    expect(rejectedEventSummary("{")).toEqual({});
  });
});
