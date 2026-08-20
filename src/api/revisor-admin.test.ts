/**
 * /v1/admin/revisor — 設定画面から workflow token を入れられることの固定。
 *
 * この API が唯一の設定口 (env フォールバックは廃止) なので、 「入れられる」
 * 「値は返らない」 「消せる」 の 3 点をここで押さえる。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema.js";
import { makeRevisorConfigRepo } from "../db/revisor-config-repo.js";
import { SecretBox } from "../shared/secret-box.js";
import { revisorAdminRouter } from "./revisor-admin.js";

const secretBox = new SecretBox(Buffer.alloc(32, 3));

describe("revisor admin API", () => {
  let db: Database.Database;
  let app: ReturnType<typeof revisorAdminRouter>;
  let config: ReturnType<typeof makeRevisorConfigRepo>;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    config = makeRevisorConfigRepo(db);
    app = revisorAdminRouter({ config, secretBox });
  });

  afterEach(() => db.close());

  const put = (body: unknown) =>
    app.request("/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("未設定なら source=none", async () => {
    const response = await app.request("/config");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workflow_token_set: false, source: "none" });
  });

  it("PUT で保存すると設定済みになり、 値は返らない", async () => {
    const response = await put({ workflow_token: "rv-secret" });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ workflow_token_set: true, source: "db" });
    expect(body).not.toContain("rv-secret");
    // 平文で置かない。
    expect(config.get("workflow_token_enc")).not.toContain("rv-secret");
  });

  it("空文字で消すと未設定に戻る", async () => {
    await put({ workflow_token: "rv-secret" });
    const response = await put({ workflow_token: "" });

    expect(await response.json()).toEqual({ workflow_token_set: false, source: "none" });
  });

  it("文字列以外の token は受け付けない", async () => {
    const response = await put({ workflow_token: 42 });
    expect(response.status).toBe(400);
  });

  it("Authorization header を壊す制御文字は受け付けない", async () => {
    const response = await put({ workflow_token: "valid-prefix\r\ninjected: value" });
    expect(response.status).toBe(400);
    expect(config.get("workflow_token_enc")).toBeNull();
  });
});
