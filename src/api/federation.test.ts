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

  it("拠点タグ用の Villa PC 対応を設定・解除し、未登録拠点は 404 を返す", async () => {
    const app = federationRouter({
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 10, ttlSec: 60 }),
      connections: createFederationConnections(),
      listenerEnabled: true,
    });
    const put = (siteId: string, body: unknown) => app.request(`http://local/sites/${siteId}/villa-pc`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await put("site-a", { villa_pc_id: "pc-haster" })).status).toBe(200);
    expect(sites.find("site-a")?.villa_pc_id).toBe("pc-haster");

    // null は「対応解除」 (拠点タグ候補から外す) として受ける。
    expect((await put("site-a", { villa_pc_id: null })).status).toBe(200);
    expect(sites.find("site-a")?.villa_pc_id).toBeNull();

    expect((await put("site-a", { villa_pc_id: "" })).status).toBe(400);
    expect((await put("missing", { villa_pc_id: "pc-haster" })).status).toBe(404);
  });
});
