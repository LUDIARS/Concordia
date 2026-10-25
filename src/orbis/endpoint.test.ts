import { describe, expect, it, vi } from "vitest";
import { resolveOrbisEndpoint } from "./endpoint.js";
import { discoverOrbisEndpoint } from "./discovery.js";
import { ExcubitorClient } from "../excubitor/client.js";

describe("Orbis Excubitor discovery", () => {
  it("prefers the declared Vinculum port over other observed Electron listeners", () => {
    expect(resolveOrbisEndpoint({ port: 25001, catalog_snapshot: { port: 25002 } }, { instance_id: "cc-instance" }))
      .toEqual({ url: "http://127.0.0.1:25002/", instanceId: "cc-instance" });
    expect(resolveOrbisEndpoint({ port: null, catalog_snapshot: { port: 25002 } }, { instance_id: "cc-instance" }).url)
      .toBe("http://127.0.0.1:25002/");
  });
  it.each([null, 0, -1, 65536, NaN, Infinity, 1.5])("rejects invalid declared port %s even with a valid observation", port => {
    expect(() => resolveOrbisEndpoint({ port: 25001, catalog_snapshot: { port } }, { instance_id: "cc" }))
      .toThrow(/^orbis_unavailable$/);
  });
  it("uses observations only when no catalog port is declared, as Actio does", () => {
    for (const service of [{ port: 25001 }, { port: 25001, catalog_snapshot: null },
      { port: 25001, catalog_snapshot: {} }, { port: 25001, catalog_snapshot: { port: undefined } }]) {
      expect(resolveOrbisEndpoint(service, { instance_id: "cc" }).url).toBe("http://127.0.0.1:25001/");
    }
    for (const port of [null, undefined, 0, -1, 65536, NaN, Infinity, 1.5]) {
      expect(() => resolveOrbisEndpoint({ port }, { instance_id: "cc" })).toThrow(/^orbis_unavailable$/);
    }
    expect(() => resolveOrbisEndpoint(null, { instance_id: "cc" })).toThrow("orbis_unavailable");
  });
  it("still rejects absent or invalid Cc instance identity", () => {
    for (const concordia of [null, {}, { instance_id: "" }, { instance_id: "cc invalid" },
      { instance_id: "cc\n" }, { instance_id: "a".repeat(129) }, { instance_id: 42 }]) {
      expect(() => resolveOrbisEndpoint({ port: 25001, catalog_snapshot: { port: 25002 } }, concordia))
        .toThrow(/^orbis_unavailable$/);
    }
  });
  it("reuses the common HTTP client for both service detail endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      return Response.json(url.endsWith("/orbis") ? { code: "orbis", port: 25001, catalog_snapshot: { port: 25002 } }
        : { code: "concordia", instance_id: "cc-instance" });
    });
    expect(await discoverOrbisEndpoint(new ExcubitorClient({ baseUrl: "http://excubitor.test", fetchImpl })))
      .toEqual({ url: "http://127.0.0.1:25002/", instanceId: "cc-instance" });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      "http://excubitor.test/api/v1/services/orbis", "http://excubitor.test/api/v1/services/concordia",
    ]);
  });
  it("does not surface discovery exception details", async () => {
    await expect(discoverOrbisEndpoint({ findService: async () => { throw new Error("secret-url?token=private"); } }))
      .rejects.toThrow(/^orbis_unavailable$/);
  });
});
