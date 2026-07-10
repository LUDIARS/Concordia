import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "./helpers/db.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { DelegationService } from "../src/delegation/service.js";
import { delegationRouter } from "../src/api/delegation.js";
import {
  PORTABLE_KIND,
  parsePortable,
  templateToPortable,
} from "../src/delegation/portable.js";

function makeApp() {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const service = new DelegationService({ repo, spawn: () => ({ ok: true, pid: 1, command: [] }) });
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({ repo, service }));
  return { app, repo };
}

describe("portable delegation (round-trip)", () => {
  it("templateToPortable は kind/version + project/default_cwd を含む", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const row = repo.createTemplate({
      call_name: "fix-bug", title: "バグ修正", target_provider: "codex",
      prompt_template: "${desc}", default_cwd: "E:/x", project: "Pictor",
      input_schema: [{ name: "desc", type: "string", required: true }],
      sort_order: 42,
    });
    const p = templateToPortable(row);
    expect(p.kind).toBe(PORTABLE_KIND);
    expect(p.version).toBe(1);
    expect(p.call_name).toBe("fix-bug");
    expect(p.project).toBe("Pictor");
    expect(p.default_cwd).toBe("E:/x");
    expect(p.sort_order).toBe(42);
    expect(p.input_schema).toEqual([{ name: "desc", type: "string", required: true }]);
  });

  it("parsePortable は余剰キーを無視し target_provider を検証する", () => {
    const ok = parsePortable({ target_provider: "claude", call_name: "x", extra: "ignored" });
    expect(ok.ok).toBe(true);
    const bad = parsePortable({ target_provider: "gpt-cli" });
    expect(bad.ok).toBe(false);
  });
});

describe("GET /v1/delegation/templates/:id/export + POST import", () => {
  let app: Hono;
  let repo: DelegationRepo;
  beforeEach(() => { const m = makeApp(); app = m.app; repo = m.repo; });

  it("export → import で同等の新規テンプレが立つ (call_name は自動採番で衝突回避)", async () => {
    const src = repo.createTemplate({
      call_name: "refactor", title: "リファクタ", target_provider: "claude",
      prompt_template: "do ${what}", default_cwd: "E:/r", project: "Ergo",
      input_schema: [{ name: "what", type: "string", required: true }],
      sort_order: 77,
    });
    const ex = await app.request(`/v1/delegation/templates/${src.id}/export`);
    expect(ex.status).toBe(200);
    const portable = ((await ex.json()) as { delegation: unknown }).delegation;

    const imp = await app.request("/v1/delegation/templates/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(portable),
    });
    expect(imp.status).toBe(201);
    const created = ((await imp.json()) as { template: { call_name: string; project: string | null; default_cwd: string | null; prompt_template: string; sort_order: number } }).template;
    // call_name は衝突回避で別名 (refactor-2 等)、 中身は引き継がれる。
    expect(created.call_name).not.toBe("refactor");
    expect(created.project).toBe("Ergo");
    expect(created.default_cwd).toBe("E:/r");
    expect(created.prompt_template).toBe("do ${what}");
    expect(created.sort_order).toBe(77);
  });

  it("export は不明 id で 404", async () => {
    const r = await app.request("/v1/delegation/templates/nope/export");
    expect(r.status).toBe(404);
  });

  it("import は不正 provider で 400", async () => {
    const r = await app.request("/v1/delegation/templates/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_provider: "nope" }),
    });
    expect(r.status).toBe(400);
  });
});
