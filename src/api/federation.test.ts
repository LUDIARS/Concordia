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

  it("拠点間ワンショット調査を宛先へ渡して結果を返し、 不正な依頼は 400、 未構成は 503 を返す", async () => {
    const requestInquiry = vi.fn(async () => ({ ok: true, output: "答え", error: null, executedBy: "site-a", durationMs: 9 }));
    const base = {
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 10, ttlSec: 60 }),
      connections: createFederationConnections(),
      listenerEnabled: true,
    };
    const app = federationRouter({ ...base, requestInquiry });
    const post = (target: typeof app, body: unknown) => target.request("http://local/inquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const ok = await post(app, { target: "site-a", prompt: "ログを見て", project: "Concordia", timeout_sec: 60 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, executed_by: "site-a", output: "答え", error: null, duration_ms: 9 });
    expect(requestInquiry).toHaveBeenCalledWith({ target: "site-a", prompt: "ログを見て", project: "Concordia", timeoutSec: 60 });

    expect((await post(app, { target: "site-a", prompt: "x", project: "../etc" })).status).toBe(400);
    expect((await post(app, { target: "site-a", prompt: "" })).status).toBe(400);
    expect((await post(federationRouter(base), { target: "hq", prompt: "x" })).status).toBe(503);
  });

  it("拠点間ワンショット調査の失敗は 502 で理由を返す", async () => {
    const app = federationRouter({
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 10, ttlSec: 60 }),
      connections: createFederationConnections(),
      listenerEnabled: true,
      requestInquiry: async () => ({ ok: false, output: "", error: "site is offline: site-a", executedBy: "site-a", durationMs: null }),
    });
    const response = await app.request("http://local/inquiries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "site-a", prompt: "x" }),
    });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("site is offline: site-a");
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

  it("listener の動的状態を一覧へ反映し、未知の更新キーを拒否する", async () => {
    let enabled = false;
    const app = federationRouter({
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 10, ttlSec: 60 }),
      connections: createFederationConnections(),
      listenerEnabled: false,
      listenerStatus: () => ({
        config: {
          enabled,
          port: enabled ? 11112 : null,
          host: "127.0.0.1",
          source: { enabled: "db", port: "db", host: "default" },
        },
        running: null,
      }),
      updateListener: async () => ({ ok: false, error: "not used" }),
    });

    enabled = true;
    const list = await app.request("http://local/");
    expect(await list.json()).toMatchObject({ listener_enabled: true });

    const invalid = await app.request("http://local/listener", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabeld: true }),
    });
    expect(invalid.status).toBe(400);
  });

  it("拠点トークンを更新応答へ含めない", async () => {
    const app = federationRouter({
      sites,
      outbox: makeFederationOutboxRepo(db, { maxRows: 10, ttlSec: 60 }),
      connections: createFederationConnections(),
      listenerEnabled: false,
      updateSite: async () => ({
        ok: true,
        config: {
          hqUrl: "wss://hq.example",
          siteId: "site-a",
          hasToken: true,
          source: { hqUrl: "db", siteId: "db", token: "db" },
        },
        running: null,
      }),
    });
    const response = await app.request("http://local/site", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "private-test-token" }),
    });
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(body).not.toContain("private-test-token");
    expect(body).toContain('"hasToken":true');
  });
});
