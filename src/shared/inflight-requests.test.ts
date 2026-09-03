import { beforeEach, describe, expect, it } from "vitest";

import {
  beginRequest,
  endRequest,
  inFlightRequestCount,
  resetInFlightRequests,
  snapshotInFlightRequests,
} from "./inflight-requests.js";

describe("in-flight request ledger", () => {
  beforeEach(() => resetInFlightRequests());

  it("reports nothing while no request is running", () => {
    expect(snapshotInFlightRequests(1000)).toEqual([]);
    expect(inFlightRequestCount()).toBe(0);
  });

  it("reports running requests oldest first with their age", () => {
    beginRequest("GET", "/v1/harness/audit", 1000);
    beginRequest("POST", "/v1/harness/gate", 1400);

    expect(snapshotInFlightRequests(1500)).toEqual([
      { method: "GET", path: "/v1/harness/audit", ageMs: 500 },
      { method: "POST", path: "/v1/harness/gate", ageMs: 100 },
    ]);
  });

  it("drops a request once it ends", () => {
    const handle = beginRequest("GET", "/v1/sessions", 1000);
    endRequest(handle);
    expect(snapshotInFlightRequests(1200)).toEqual([]);
    expect(inFlightRequestCount()).toBe(0);
  });

  it("keeps concurrent requests to the same path separate", () => {
    const first = beginRequest("GET", "/v1/sessions", 1000);
    beginRequest("GET", "/v1/sessions", 1100);
    endRequest(first);

    expect(snapshotInFlightRequests(1200)).toEqual([
      { method: "GET", path: "/v1/sessions", ageMs: 100 },
    ]);
  });

  it("redacts credentials and bounds paths before retaining them", () => {
    const credential = ["sk", "examplecredential"].join("-");
    beginRequest("GET", `/v1/${credential}`, 1000);
    beginRequest("GET", `/v1/${"x".repeat(600)}`, 1000);

    const snapshot = snapshotInFlightRequests(1100);
    expect(snapshot[0]?.path).toBe("/v1/[REDACTED]");
    expect(snapshot[0]?.path).not.toContain(credential);
    expect(snapshot[1]?.path.length).toBeLessThanOrEqual(512);
    expect(snapshot[1]?.path.endsWith("…")).toBe(true);
  });

  it("tolerates ending the same request twice", () => {
    const handle = beginRequest("GET", "/v1/sessions", 1000);
    endRequest(handle);
    expect(() => endRequest(handle)).not.toThrow();
    expect(inFlightRequestCount()).toBe(0);
  });

  // 停止時のログ 1 行が肥大しないように件数を絞る。 全体数は別に添えるので、
  // 「絞られた」 ことは読み手に分かる。
  it("caps the snapshot but still counts everything", () => {
    for (let i = 0; i < 25; i += 1) beginRequest("GET", `/v1/thing/${i}`, 1000 - i);

    expect(snapshotInFlightRequests(2000)).toHaveLength(10);
    expect(snapshotInFlightRequests(2000, 3)).toHaveLength(3);
    expect(inFlightRequestCount()).toBe(25);
  });

  it("orders the snapshot by age so the longest-running request comes first", () => {
    beginRequest("GET", "/fast", 1900);
    beginRequest("GET", "/slow", 1000);
    beginRequest("GET", "/middle", 1500);

    expect(snapshotInFlightRequests(2000).map((r) => r.path)).toEqual(["/slow", "/middle", "/fast"]);
  });
});
