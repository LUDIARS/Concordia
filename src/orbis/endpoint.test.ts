import { describe, expect, it, vi } from "vitest";
import { resolveOrbisEndpoint } from "./endpoint.js";
import { discoverOrbisEndpoint } from "./discovery.js";
import { ExcubitorClient } from "../excubitor/client.js";

describe("Orbis Excubitor discovery", () => {
  it("prefers observed port, otherwise uses catalog; requires actual Cc identity", () => {
    expect(resolveOrbisEndpoint({ port: 25001, catalog_snapshot: { port: 25002 } }, { instance_id: "cc-instance" }))
      .toEqual({ url: "http://127.0.0.1:25001/", instanceId: "cc-instance" });
    expect(resolveOrbisEndpoint({ port: null, catalog_snapshot: { port: 25002 } }, { instance_id: "cc-instance" }).url)
      .toBe("http://127.0.0.1:25002/");
    for (const port of [0, -1, 65536, NaN]) expect(() => resolveOrbisEndpoint({ port }, { instance_id: "cc" })).toThrow("orbis_unavailable");
    expect(() => resolveOrbisEndpoint({ port: 25001 }, {})).toThrow("orbis_unavailable");
    expect(() => resolveOrbisEndpoint(null, { instance_id: "cc" })).toThrow("orbis_unavailable");
  });
  it("reuses the common HTTP client for both service detail endpoints", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      return Response.json(url.endsWith("/orbis") ? { code: "orbis", port: null, catalog_snapshot: { port: 25002 } }
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
