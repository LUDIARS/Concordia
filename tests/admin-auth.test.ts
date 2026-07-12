import { describe, it, expect } from "vitest";
import { tokensMatch, extractBearer } from "../src/shared/admin-auth.js";
import { makeTestApp } from "./helpers/test-app.js";

function makeApp(adminToken: string) {
  return makeTestApp({ rng: () => 0.99, config: { adminToken } }).app;
}

describe("admin-auth helpers", () => {
  it("tokensMatch は一致のみ true、 空は不一致", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "ab")).toBe(false);
    expect(tokensMatch("", "")).toBe(false);
    expect(tokensMatch("abc", "")).toBe(false);
  });

  it("extractBearer は Bearer scheme を大小無視で剥がす", () => {
    expect(extractBearer("Bearer xyz")).toBe("xyz");
    expect(extractBearer("bearer  xyz ")).toBe("xyz");
    expect(extractBearer("Basic xyz")).toBe("");
    expect(extractBearer(undefined)).toBe("");
  });
});

describe("admin auth middleware on admin and dangerous mutation routes", () => {
  it("token 未設定なら無認証で通る (loopback 信頼境界)", async () => {
    const app = makeApp("");
    const r = await app.request("/v1/sweeper/run", { method: "POST" });
    expect(r.status).toBe(200);
    const r2 = await app.request("/v1/admin/truncate-sessions", { method: "POST" });
    expect(r2.status).toBe(200);
  });

  it("token 設定済み + ヘッダ無しは 401", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", { method: "POST" });
    expect(r.status).toBe(401);
    const r2 = await app.request("/v1/admin/truncate-sessions", { method: "POST" });
    expect(r2.status).toBe(401);
  });

  it("token 設定済み + 正しい Bearer は通る", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", {
      method: "POST",
      headers: { authorization: "Bearer s3cr3t" },
    });
    expect(r.status).toBe(200);
  });

  it("token 設定済み + X-Concordia-Admin-Token でも通る", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", {
      method: "POST",
      headers: { "x-concordia-admin-token": "s3cr3t" },
    });
    expect(r.status).toBe(200);
  });

  it("token 設定済み + 誤った token は 401", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/v1/sweeper/run", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(r.status).toBe(401);
  });

  it("admin 以外のルートは token 設定済みでも素通し", async () => {
    const app = makeApp("s3cr3t");
    const r = await app.request("/health");
    expect(r.status).toBe(200);
  });

  it.each([
    ["POST", "/v1/sessions/missing/inject"],
    ["POST", "/v1/delegation/invoke"],
    ["DELETE", "/v1/sessions/missing"],
  ] as const)("requires the admin token for %s %s", async (method, path) => {
    const protectedApp = makeApp("s3cr3t");
    const denied = await protectedApp.request(path, { method });
    expect(denied.status).toBe(401);

    const loopbackApp = makeApp("");
    const local = await loopbackApp.request(path, { method });
    expect(local.status).not.toBe(401);
  });
});
