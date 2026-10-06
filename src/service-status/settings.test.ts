import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeDiscordConfigRepo } from "../db/discord-repo.js";
import { statusServiceKey } from "./policy.js";
import { headquartersStatusSettings, statusSettings } from "./settings.js";
describe("scoped status settings", () => {
  it("fails closed and isolates subsidiaries while sharing the same HQ and bot storage", () => {
    const db = makeTestDb();
    try {
      const hq = makeDiscordConfigRepo(db); const glab = headquartersStatusSettings(hq, "glab");
      expect(glab.get()).toEqual({ sites: [], services: [] });
      const service = statusServiceKey("peer:glab", "glab");
      glab.set({ sites: ["peer:glab"], services: [service, service] });
      expect(statusSettings(db, "glab").get()).toEqual({ sites: ["peer:glab"], services: [service] });
      expect(statusSettings(db, "other").get()).toEqual({ sites: [], services: [] });
      hq.set("sub:glab::service_status_selection", "broken");
      expect(glab.get()).toEqual({ sites: [], services: [] });
    } finally { db.close(); }
  });
});
