import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "./helpers/db.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { DelegationService } from "../src/delegation/service.js";
import { delegationRouter } from "../src/api/delegation.js";

function makeApp() {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const service = new DelegationService({ repo, spawn: () => ({ ok: true, pid: 1, command: [] }) });
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({ repo, service }));
  return { app, repo };
}

async function postTemplate(app: Hono, body: unknown) {
  return app.request("/v1/delegation/templates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/delegation/templates (空欄許容)", () => {
  let app: Hono;
  beforeEach(() => { app = makeApp().app; });

  it("call_name / title / prompt_template すべて空でも 201、 call_name を自動採番", async () => {
    const r = await postTemplate(app, { target_provider: "codex" });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.template.call_name).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(j.template.prompt_template).toBe("");
    // title 空は call_name で代替
    expect(j.template.title).toBe(j.template.call_name);
  });

  it("title からスラッグ化して call_name を作る", async () => {
    const r = await postTemplate(app, { target_provider: "codex", title: "Build The Thing" });
    const j = (await r.json()) as any;
    expect(j.template.call_name).toBe("build-the-thing");
  });

  it("call_name 衝突時は連番でユニーク化する", async () => {
    await postTemplate(app, { target_provider: "codex", call_name: "dup", title: "x" });
    const r = await postTemplate(app, { target_provider: "codex", call_name: "dup", title: "y" });
    const j = (await r.json()) as any;
    expect(j.template.call_name).toBe("dup-2");
  });

  it("日本語 title だけのときはランダム tpl- 採番", async () => {
    const r = await postTemplate(app, { target_provider: "codex", title: "実装委託" });
    const j = (await r.json()) as any;
    expect(j.template.call_name).toMatch(/^tpl-[0-9a-f]{8}$/);
  });
});

describe("GET /v1/delegation/templates runtime options", () => {
  it("returns provider-specific runtime option suggestions", async () => {
    const { app } = makeApp();
    await postTemplate(app, { target_provider: "codex", call_name: "codex-job", title: "Codex Job" });
    await postTemplate(app, { target_provider: "claude", call_name: "claude-job", title: "Claude Job" });
    const r = await app.request("/v1/delegation/templates");
    const j = (await r.json()) as any;
    const codex = j.templates.find((t: any) => t.call_name === "codex-job");
    const claude = j.templates.find((t: any) => t.call_name === "claude-job");
    expect(codex.runtime_options.map((opt: any) => opt.key)).toContain("model_reasoning_effort");
    expect(claude.runtime_options).toEqual([]);
  });
});
