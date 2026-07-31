import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeFederationSitesRepo, type FederationSitesRepo } from "../db/federation-sites-repo.js";
import { makeFederationOutboxRepo } from "../db/federation-outbox-repo.js";
import { SecretBox } from "../shared/secret-box.js";
import { createFederationConnections } from "../federation/hq-connections.js";
import { federationRouter } from "./federation.js";

describe("federation management API", () => {
  let db: Database.Database;
  let sites: FederationSitesRepo;

  beforeEach(() => {
    db = makeTestDb();
    sites = makeFederationSitesRepo(db, new SecretBox(Buffer.alloc(32, 9)));
    sites.create({ siteId: "site-a" });
  });

  it("stores department assignments and explicitly redistributes configuration", async () => {
    const redistributeConfig = vi.fn(() => true);
    const app = federationRouter({
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 10, ttlSec: 60 }),
      connections: createFederationConnections(),
      listenerEnabled: true,
      redistributeConfig,
    });

    const departments = await app.request("http://local/sites/site-a/departments", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ departments: ["g1", "g1"] }),
    });
    const config = await app.request("http://local/sites/site-a/config", { method: "POST" });

    expect(departments.status).toBe(200);
    expect(sites.find("site-a")?.departments).toEqual(["g1"]);
    expect(await config.json()).toEqual({ ok: true, site_id: "site-a", delivered: true });
    expect(redistributeConfig).toHaveBeenCalledWith("site-a");
  });
});
