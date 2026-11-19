import { describe, expect, it, vi } from "vitest";

import type { ExcubitorClient } from "../excubitor/client.js";
import { RevisorRequestError } from "./revisor-http.js";
import {
  isRevisorHealth,
  REMEMBERED_PORT_TTL_MS,
  RevisorEndpointResolver,
  revisorFallbackCandidates,
} from "./revisor-endpoint.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const REVISOR_HEALTH = { ok: true, service: "revisor", version: "1.0.0" };

/** 呼び出し順に結果を返す (最後の値は以降も繰り返す)。 Error は throw、 null は未登録。 */
function excubitorReturning(...results: Array<number | Error | null>): Pick<ExcubitorClient, "findService"> {
  const findService = vi.fn(async () => {
    const next = results.length > 1 ? results.shift() : results[0];
    if (next instanceof Error) throw next;
    if (next === null || next === undefined) return null;
    return { code: "revisor", name: "Revisor", port: next, state: "running" };
  });
  return { findService } as unknown as Pick<ExcubitorClient, "findService">;
}

/** port → /health 応答。 未登録ポートは接続拒否。 */
function healthFetch(byPort: Record<number, unknown>) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const port = Number(url.port);
    if (url.pathname !== "/health" || !(port in byPort)) throw new TypeError("fetch failed");
    return json(byPort[port]);
  });
}

describe("revisorFallbackCandidates", () => {
  it("orders the remembered port before the declared port and drops duplicates", () => {
    expect(revisorFallbackCandidates({ remembered: { port: 5001, at: 0 }, declared: 4240, now: 10 })).toEqual([5001, 4240]);
    expect(revisorFallbackCandidates({ remembered: { port: 4240, at: 0 }, declared: 4240, now: 10 })).toEqual([4240]);
  });

  it("drops an expired remembered port and invalid values", () => {
    expect(revisorFallbackCandidates({
      remembered: { port: 5001, at: 0 },
      declared: 4240,
      now: REMEMBERED_PORT_TTL_MS + 1,
    })).toEqual([4240]);
    expect(revisorFallbackCandidates({ remembered: { port: 0, at: 0 }, declared: 70_000, now: 1 })).toEqual([]);
    expect(revisorFallbackCandidates({ remembered: null, declared: null, now: 1 })).toEqual([]);
  });
});

describe("isRevisorHealth", () => {
  it("accepts only an ok health body that names revisor", () => {
    expect(isRevisorHealth(REVISOR_HEALTH)).toBe(true);
    expect(isRevisorHealth({ ok: true, service: "actio" })).toBe(false);
    expect(isRevisorHealth({ ok: false, service: "revisor" })).toBe(false);
    expect(isRevisorHealth({ ok: "true", service: "revisor" })).toBe(false);
    expect(isRevisorHealth(null)).toBe(false);
    expect(isRevisorHealth("revisor")).toBe(false);
  });
});

describe("RevisorEndpointResolver", () => {
  it("uses the Excubitor port when the lookup succeeds", async () => {
    const fetchImpl = healthFetch({});
    const resolver = new RevisorEndpointResolver({ excubitor: excubitorReturning(4240), fetchImpl });
    expect(await resolver.resolvePort()).toBe(4240);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses the remembered port when Excubitor fails and /health answers as revisor", async () => {
    let now = 1_000;
    const fetchImpl = healthFetch({ 5001: REVISOR_HEALTH });
    const resolver = new RevisorEndpointResolver({
      excubitor: excubitorReturning(5001, new TypeError("fetch failed")),
      fetchImpl,
      now: () => now,
    });
    expect(await resolver.resolvePort()).toBe(5001);
    now += 60_000;
    expect(await resolver.resolvePort()).toBe(5001);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:5001/health");
  });

  it("falls back to the catalog-declared port when nothing is remembered", async () => {
    const resolver = new RevisorEndpointResolver({
      excubitor: excubitorReturning(new TypeError("fetch failed")),
      declaredPort: async () => 4240,
      fetchImpl: healthFetch({ 4240: REVISOR_HEALTH }),
    });
    expect(await resolver.resolvePort()).toBe(4240);
  });

  it("also falls back when Excubitor answers without a usable port", async () => {
    const resolver = new RevisorEndpointResolver({
      excubitor: excubitorReturning(null),
      declaredPort: async () => 4240,
      fetchImpl: healthFetch({ 4240: REVISOR_HEALTH }),
    });
    expect(await resolver.resolvePort()).toBe(4240);
  });

  it("rejects a candidate whose /health belongs to another service", async () => {
    const resolver = new RevisorEndpointResolver({
      excubitor: excubitorReturning(new TypeError("fetch failed")),
      declaredPort: async () => 4240,
      fetchImpl: healthFetch({ 4240: { ok: true, service: "actio" } }),
    });
    const error = await resolver.resolvePort().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RevisorRequestError);
    expect((error as RevisorRequestError).reason).toBe("lookup_failed");
  });

  it("does not reuse a remembered port past its TTL", async () => {
    let now = 0;
    const fetchImpl = healthFetch({ 5001: REVISOR_HEALTH });
    const resolver = new RevisorEndpointResolver({
      excubitor: excubitorReturning(5001, new TypeError("fetch failed")),
      fetchImpl,
      now: () => now,
      ttlMs: 1_000,
    });
    expect(await resolver.resolvePort()).toBe(5001);
    now = 1_001;
    await expect(resolver.resolvePort()).rejects.toMatchObject({ reason: "lookup_failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps transport wording out of the lookup_failed message", async () => {
    const resolver = new RevisorEndpointResolver({
      excubitor: excubitorReturning(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:5101")),
      declaredPort: async () => { throw new Error("ENOENT"); },
      fetchImpl: healthFetch({}),
    });
    const error = await resolver.resolvePort().catch((e: unknown) => e) as RevisorRequestError;
    expect(error.reason).toBe("lookup_failed");
    expect(error.message).toContain("Revisor endpoint could not be resolved");
    expect(error.message).toContain("The request was not sent to Revisor");
    expect(error.message).not.toMatch(/fetch failed|ECONNREFUSED|ENOENT/);
  });
});
