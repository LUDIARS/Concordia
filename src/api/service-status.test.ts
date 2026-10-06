import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordConfigRepo } from "../db/discord-repo.js";
import { serviceStatusRouter } from "./service-status.js";
import { statusServiceKey, type StatusSnapshot } from "../service-status/policy.js";
import { createServiceVisibilityPolicy } from "../service-status/visibility.js";
const visibility = createServiceVisibilityPolicy({
  restrictedSites: ["restricted-site"],
  restrictedServices: ["restricted-service"],
});
function snapshot(): StatusSnapshot {
  const now = Date.now();
  return { generatedAt: now, staleAfterMs: 60_000, sites: [
    { id: "self", name: "HQ", self: true, connected: true, stale: false },
    { id: "peer:restricted", name: "Restricted Site", self: false, connected: true, stale: false },
  ], services: [
    { siteId: "self", code: "cc", name: "Concordia", project: "Cc", repository: "internal/source-location", state: "up", checkedAt: now },
    { siteId: "self", code: "restricted-service", name: "Restricted Service", project: "Restricted", repository: null, state: "up", checkedAt: now },
  ] };
}
describe("status configuration API", () => {
  it("forbids selecting private sites/services and does not leak them in filtered status or candidates", async () => {
    const db = makeTestDb();
    try {
      const app = serviceStatusRouter({ config: makeDiscordConfigRepo(db), exists: (id) => id === "glab", read: async () => snapshot(), visibility });
      const put = (body: unknown) => app.request("/subsidiaries/glab/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await put({ sites: ["peer:restricted"], services: [] })).status).toBe(400);
      expect((await put({ sites: ["self"], services: [statusServiceKey("self", "restricted-service")] })).status).toBe(400);
      expect((await put({ sites: ["self"], services: [statusServiceKey("self", "cc")] })).status).toBe(200);
      const status = await (await app.request("/subsidiaries/glab/status")).text();
      expect(status).toContain("Concordia"); expect(status).not.toContain("Restricted Service"); expect(status).not.toContain("Restricted Site");
      expect(status).not.toContain("source-location");
      const candidates = await (await app.request("/subsidiaries/glab/candidates?site=self")).text();
      expect(candidates).not.toContain("Restricted Service"); expect(candidates).not.toContain("Restricted Site");
      const cleared = await (await app.request("/subsidiaries/glab/candidates?selection=explicit")).json() as { services: unknown[] };
      expect(cleared.services).toEqual([]);
      expect((await app.request("/subsidiaries/unknown/settings")).status).toBe(404);
      expect((await app.request("/")).status).toBe(200);
    } finally { db.close(); }
  });
  it("never saves a selection from unavailable or malformed observations", async () => {
    const db = makeTestDb();
    try {
      const app = serviceStatusRouter({ config: makeDiscordConfigRepo(db), exists: () => true, read: async () => { throw new Error("offline"); } });
      const response = await app.request("/subsidiaries/glab/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sites: ["self"], services: [statusServiceKey("self", "cc")] }) });
      expect(response.status).toBe(503);
      expect(await (await app.request("/subsidiaries/glab/settings")).json()).toEqual({ selection: { sites: [], services: [] } });
    } finally { db.close(); }
  });
});
