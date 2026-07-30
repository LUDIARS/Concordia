import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./schema.js";
import { makeFederationSitesRepo } from "./federation-sites-repo.js";
import { SecretBox } from "../shared/secret-box.js";

const secretBox = new SecretBox(Buffer.alloc(32, 7));

describe("FederationSitesRepo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
  });

  afterEach(() => db.close());

  it("issues a token once, stores it encrypted, and verifies in constant-time compare", () => {
    const repo = makeFederationSitesRepo(db, secretBox, () => 100);
    const { row, token } = repo.create({ siteId: "site-a", name: "拠点A" });
    expect(row.site_id).toBe("site-a");
    expect(row.status).toBe("active");
    // 平文トークンが DB に載っていないこと (at-rest 暗号化)。
    expect(row.token_enc).not.toContain(token);
    expect(row.token_enc.startsWith("enc:v1:")).toBe(true);

    expect(repo.verifyToken("site-a", token)).toBe(true);
    expect(repo.verifyToken("site-a", token + "x")).toBe(false);
    expect(repo.verifyToken("unknown", token)).toBe(false);
  });

  it("revoke stops verification and records the timestamp", () => {
    const repo = makeFederationSitesRepo(db, secretBox, () => 200);
    const { token } = repo.create({ siteId: "site-b" });
    expect(repo.revoke("site-b")).toBe(true);
    expect(repo.verifyToken("site-b", token)).toBe(false);
    expect(repo.find("site-b")?.status).toBe("revoked");
    expect(repo.find("site-b")?.revoked_at).toBe(200);
    // 二重 revoke は no-op。
    expect(repo.revoke("site-b")).toBe(false);
  });

  it("touchConnected / touchSeen update liveness columns", () => {
    let now = 300;
    const repo = makeFederationSitesRepo(db, secretBox, () => now);
    repo.create({ siteId: "site-c" });
    repo.touchConnected("site-c", "1.2.3");
    expect(repo.find("site-c")?.last_connected_at).toBe(300);
    expect(repo.find("site-c")?.site_version).toBe("1.2.3");
    now = 350;
    repo.touchSeen("site-c");
    expect(repo.find("site-c")?.last_seen_at).toBe(350);
  });
});
