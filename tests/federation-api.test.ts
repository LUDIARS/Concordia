import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { federationRouter } from "../src/api/federation.js";
import { SecretBox } from "../src/shared/secret-box.js";
import { makeFederationSitesRepo } from "../src/db/federation-sites-repo.js";
import { makeFederationOutboxRepo } from "../src/db/federation-outbox-repo.js";
import { createFederationConnections } from "../src/federation/hq-connections.js";
import { makeTestDb } from "./helpers/db.js";

const secretBox = new SecretBox(Buffer.alloc(32, 5));

function makeApi() {
  const db = makeTestDb();
  const sites = makeFederationSitesRepo(db, secretBox);
  const outbox = makeFederationOutboxRepo(db, { maxRows: 100, ttlSec: 3600 });
  const connections = createFederationConnections();
  const disconnected: string[] = [];
  const app = new Hono();
  app.route("/v1/federation", federationRouter({
    sites,
    outbox,
    connections,
    listenerEnabled: false,
    disconnectSite: (siteId) => disconnected.push(siteId),
  }));
  return { app, sites, outbox, connections, disconnected };
}

describe("/v1/federation", () => {
  it("creates a site and returns the plaintext token exactly once", async () => {
    const env = makeApi();
    const res = await env.app.request("/v1/federation/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_id: "site-a", name: "拠点A" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { site_id: string; token: string };
    expect(body.site_id).toBe("site-a");
    expect(env.sites.verifyToken("site-a", body.token)).toBe(true);

    // 一覧にトークンは出ない。
    const list = await env.app.request("/v1/federation");
    const listBody = await list.json() as { sites: Array<Record<string, unknown>> };
    expect(JSON.stringify(listBody)).not.toContain(body.token);
    expect(listBody.sites[0].connection).toBe("offline");

    // 重複登録は 409。
    const dup = await env.app.request("/v1/federation/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_id: "site-a" }),
    });
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid site_id", async () => {
    const env = makeApi();
    const res = await env.app.request("/v1/federation/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_id: "Not Valid!" }),
    });
    expect(res.status).toBe(400);
  });

  it("revoke stops the token and disconnects a live connection", async () => {
    const env = makeApi();
    const create = await env.app.request("/v1/federation/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_id: "site-b" }),
    });
    const { token } = await create.json() as { token: string };

    const res = await env.app.request("/v1/federation/sites/site-b/revoke", { method: "POST" });
    expect(res.status).toBe(200);
    expect(env.sites.verifyToken("site-b", token)).toBe(false);
    expect(env.disconnected).toEqual(["site-b"]);

    const again = await env.app.request("/v1/federation/sites/site-b/revoke", { method: "POST" });
    expect(again.status).toBe(404);
  });

  it("shows live connection state and pending events in the list", async () => {
    const env = makeApi();
    await env.app.request("/v1/federation/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site_id: "site-c" }),
    });
    env.connections.attach({
      siteId: "site-c",
      connectedAtSec: 100,
      lastSeenSec: 150,
      siteVersion: "9.9.9",
      remoteAddress: "127.0.0.1",
    });
    env.outbox.enqueue("site-c", { n: 1 });

    const list = await env.app.request("/v1/federation");
    const body = await list.json() as { sites: Array<Record<string, unknown>> };
    expect(body.sites[0].connection).toBe("online");
    expect(body.sites[0].site_version).toBe("9.9.9");
    expect(body.sites[0].pending_events).toBe(1);
  });
});
