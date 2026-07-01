import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "./helpers/db.js";
import { SubsidiaryRepo } from "../src/db/subsidiary-repo.js";
import { DelegationRepo } from "../src/db/delegation-repo.js";
import { subsidiaryRouter } from "../src/api/subsidiary.js";

function makeApp() {
  const db = makeTestDb();
  const repo = new SubsidiaryRepo(db);
  const delegationRepo = new DelegationRepo(db);
  const manager = { isRunning: () => false } as never;
  const secretBox = { encrypt: (s: string) => s, decrypt: (s: string) => s } as never;
  const app = new Hono();
  app.route("/v1/subsidiaries", subsidiaryRouter({ repo, delegationRepo, manager, secretBox }));
  return { app, repo, delegationRepo };
}

async function json(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("SubsidiaryRepo owned delegations", () => {
  let repo: SubsidiaryRepo;
  let subId: string;
  beforeEach(() => {
    const db = makeTestDb();
    repo = new SubsidiaryRepo(db);
    subId = repo.create({ name: "co", platform: "discord", enabled: true, guild_id: "g" }).id;
  });

  it("upsert → find → update (cwd/project は所有側で保持)", () => {
    repo.upsertDelegation(subId, {
      call_name: "fix", title: "修正", target_provider: "claude",
      prompt_template: "p", default_cwd: "E:/a", project: "Pictor",
    });
    let row = repo.findDelegation(subId, "fix")!;
    expect(row.default_cwd).toBe("E:/a");
    expect(row.project).toBe("Pictor");
    // 部分更新: project だけ変える (他は据え置き)。
    repo.upsertDelegation(subId, { call_name: "fix", project: "Ergo" });
    row = repo.findDelegation(subId, "fix")!;
    expect(row.project).toBe("Ergo");
    expect(row.default_cwd).toBe("E:/a");
    expect(row.title).toBe("修正");
  });

  it("setDefaultDelegation は 1 件だけ立てる", () => {
    repo.upsertDelegation(subId, { call_name: "a", target_provider: "claude" });
    repo.upsertDelegation(subId, { call_name: "b", target_provider: "claude" });
    repo.setDefaultDelegation(subId, "a");
    repo.setDefaultDelegation(subId, "b");
    const rows = repo.listDelegations(subId);
    expect(rows.filter((r) => r.is_default === 1).map((r) => r.call_name)).toEqual(["b"]);
    expect(repo.defaultDelegation(subId)?.call_name).toBe("b");
  });

  it("remove で消える", () => {
    repo.upsertDelegation(subId, { call_name: "x", target_provider: "claude" });
    expect(repo.removeDelegation(subId, "x")).toBe(true);
    expect(repo.findDelegation(subId, "x")).toBeNull();
  });
});

describe("subsidiary owned-delegation API", () => {
  let app: Hono;
  let repo: SubsidiaryRepo;
  let delegationRepo: DelegationRepo;
  let subId: string;
  beforeEach(() => {
    const m = makeApp();
    app = m.app; repo = m.repo; delegationRepo = m.delegationRepo;
    subId = repo.create({ name: "co", platform: "discord", enabled: true, guild_id: "g" }).id;
  });

  it("clone: グローバルテンプレを所有 delegation に複製する", async () => {
    delegationRepo.createTemplate({
      call_name: "fix-content", title: "誤字修正", target_provider: "claude",
      prompt_template: "fix ${f}", default_cwd: "E:/p", project: "Pictor",
      input_schema: [{ name: "f", type: "string", required: true }],
    });
    const r = await json(app, "POST", `/v1/subsidiaries/${subId}/delegations/clone`, { call_name: "fix-content", is_default: true });
    expect(r.status).toBe(201);
    expect(r.body.delegation).toMatchObject({ call_name: "fix-content", project: "Pictor", default_cwd: "E:/p", is_default: true });
    // 一覧 (GET /:id) に所有 delegation が input_schema 配列付きで載る。
    const g = await json(app, "GET", `/v1/subsidiaries/${subId}`);
    expect(g.body.delegations[0].call_name).toBe("fix-content");
    expect(Array.isArray(g.body.delegations[0].input_schema)).toBe(true);
  });

  it("PUT (JSON 貼付) で upsert → GET export で可搬 JSON を取り出す", async () => {
    const put = await json(app, "PUT", `/v1/subsidiaries/${subId}/delegations/my-task`, {
      target_provider: "codex", title: "T", prompt_template: "do", default_cwd: "E:/q", project: "Ergo",
    });
    expect(put.status).toBe(200);
    expect(put.body.delegation).toMatchObject({ call_name: "my-task", project: "Ergo" });
    const ex = await json(app, "GET", `/v1/subsidiaries/${subId}/delegations/my-task/export`);
    expect(ex.status).toBe(200);
    expect(ex.body.delegation).toMatchObject({ kind: "concordia.delegation", call_name: "my-task", project: "Ergo", default_cwd: "E:/q" });
  });

  it("default エンドポイントで既定を切り替え、 delete で消す", async () => {
    await json(app, "PUT", `/v1/subsidiaries/${subId}/delegations/a`, { target_provider: "claude" });
    await json(app, "PUT", `/v1/subsidiaries/${subId}/delegations/b`, { target_provider: "claude" });
    const d = await json(app, "POST", `/v1/subsidiaries/${subId}/delegations/b/default`);
    expect(d.status).toBe(200);
    expect(d.body.delegations.find((x: any) => x.call_name === "b").is_default).toBe(true);
    const del = await json(app, "DELETE", `/v1/subsidiaries/${subId}/delegations/a`);
    expect(del.body.ok).toBe(true);
  });

  it("clone は不明テンプレで 404", async () => {
    const r = await json(app, "POST", `/v1/subsidiaries/${subId}/delegations/clone`, { call_name: "missing" });
    expect(r.status).toBe(404);
  });
});
