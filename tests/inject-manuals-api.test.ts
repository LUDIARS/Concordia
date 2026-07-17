import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";
import { INJECT_MANUAL_KINDS } from "../src/db/inject-manuals-repo.js";

describe("inject-manuals API", () => {
  let env: TestAppEnv;
  beforeEach(() => {
    env = makeTestApp();
  });

  it("GET /v1/admin/inject-manuals は seed 済みの全 kind を固定語彙順で返す", async () => {
    const r = await env.app.request("/v1/admin/inject-manuals");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { manuals: Array<{ kind: string; content: string; updated_at: number }> };
    expect(body.manuals.map((m) => m.kind)).toEqual([...INJECT_MANUAL_KINDS]);
    for (const m of body.manuals) expect(m.content.length).toBeGreaterThan(0);
  });

  it("PUT /v1/admin/inject-manuals/:kind は upsert して更新後の行を返す", async () => {
    const r = await env.app.request(`/v1/admin/inject-manuals/${encodeURIComponent("レビュー")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "main 最新の上で読む。git 操作はしない。" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { manual: { kind: string; content: string; updated_at: number } };
    expect(body.manual.kind).toBe("レビュー");
    expect(body.manual.content).toBe("main 最新の上で読む。git 操作はしない。");
    expect(env.injectManuals.get("レビュー")?.content).toBe("main 最新の上で読む。git 操作はしない。");
  });

  it("PUT 未知 kind は 400", async () => {
    const r = await env.app.request(`/v1/admin/inject-manuals/${encodeURIComponent("未知の種別")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("unknown_kind");
  });

  it("PUT content が string でない body は 400", async () => {
    const r = await env.app.request(`/v1/admin/inject-manuals/${encodeURIComponent("実装")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 123 }),
    });
    expect(r.status).toBe(400);
  });

  it("PUT content 32KB 超は 400", async () => {
    const r = await env.app.request(`/v1/admin/inject-manuals/${encodeURIComponent("実装")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "a".repeat(32 * 1024 + 1) }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("content_too_large");
  });
});
