import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { DepartmentsRepo } from "../db/departments-repo.js";
import { applyMigrations } from "../db/schema.js";
import { DepartmentService } from "../departments/service.js";
import { departmentsRouter } from "./departments.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function makeApp(): { app: Hono; db: Database.Database; repo: DepartmentsRepo } {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const repo = new DepartmentsRepo(db);
  const service = new DepartmentService({
    repo,
    organizations: { exists: (id) => id === "glab", projects: () => ["glab-web"] },
  });
  const app = new Hono().route("/v1/departments", departmentsRouter({
    repo,
    service,
    isKnownProvider: (provider) => ["claude", "codex"].includes(provider),
    isActiveTemplate: (callName) => callName === "claude-opus-impl",
  }));
  return { app, db, repo };
}

function post(app: Hono, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

function patch(app: Hono, path: string, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("departmentsRouter", () => {
  it("creates, lists and reads head-office departments with typed settings", async () => {
    const { app } = makeApp();
    const created = await post(app, "/v1/departments", {
      name: "開発部", slug: "dev", settings: { launch: { template: "claude-opus-impl" }, projects: ["Concordia"] },
      rules_text: "PR は Revisor 経由",
    });
    expect(created.status).toBe(201);
    const { department } = await created.json() as { department: { id: string; settings: unknown; archived: boolean } };
    expect(department).toMatchObject({ settings: { launch: { template: "claude-opus-impl" }, projects: ["Concordia"] }, archived: false });

    const list = await (await app.request("/v1/departments")).json() as { departments: Array<{ id: string }> };
    expect(list.departments.map((row) => row.id)).toEqual([department.id]);
    expect((await app.request(`/v1/departments/${department.id}`)).status).toBe(200);
    expect((await app.request("/v1/departments/missing")).status).toBe(404);
  });

  it("scopes the list by organization and can return every organization", async () => {
    const { app } = makeApp();
    await post(app, "/v1/departments", { name: "開発部", slug: "dev" });
    await post(app, "/v1/departments", { name: "開発部", slug: "dev", subsidiary_id: "glab" });
    const head = await (await app.request("/v1/departments")).json() as { departments: Array<{ subsidiary_id: string | null }> };
    const glab = await (await app.request("/v1/departments?subsidiary_id=glab")).json() as { departments: Array<{ subsidiary_id: string | null }> };
    const all = await (await app.request("/v1/departments?all_organizations=1")).json() as { departments: unknown[] };
    expect(head.departments.map((row) => row.subsidiary_id)).toEqual([null]);
    expect(glab.departments.map((row) => row.subsidiary_id)).toEqual(["glab"]);
    expect(all.departments).toHaveLength(2);
  });

  it("refuses to move a department to another organization (CC-DEPT-INV-01)", async () => {
    const { app } = makeApp();
    const created = await (await post(app, "/v1/departments", { name: "開発部", slug: "dev" })).json() as { department: { id: string } };
    const moved = await patch(app, `/v1/departments/${created.department.id}`, { subsidiary_id: "glab" });
    expect(moved.status).toBe(400);
  });

  it("validates provider, template and subsidiary scope before saving", async () => {
    const { app, repo } = makeApp();
    expect((await post(app, "/v1/departments", { name: "a", slug: "a", settings: { launch: { provider: "unknown" } } })).status).toBe(400);
    expect((await post(app, "/v1/departments", { name: "a", slug: "a", settings: { launch: { template: "missing" } } })).status).toBe(400);
    const outside = await post(app, "/v1/departments", {
      name: "a", slug: "a", subsidiary_id: "glab", settings: { projects: ["Concordia"] },
    });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toEqual({ error: "department_projects_outside_subsidiary_scope", outside: ["Concordia"] });
    expect((await post(app, "/v1/departments", { name: "a", slug: "a", subsidiary_id: "nope" })).status).toBe(404);
    expect(repo.listAll()).toEqual([]);
  });

  it("returns 409 for a duplicate slug in the same organization", async () => {
    const { app } = makeApp();
    await post(app, "/v1/departments", { name: "開発部", slug: "dev" });
    expect((await post(app, "/v1/departments", { name: "開発二部", slug: "dev" })).status).toBe(409);
  });

  it("archives and restores idempotently and hides archived rows by default", async () => {
    const { app } = makeApp();
    const created = await (await post(app, "/v1/departments", { name: "旧部", slug: "old" })).json() as { department: { id: string } };
    const id = created.department.id;
    expect((await post(app, `/v1/departments/${id}/archive`)).status).toBe(200);
    expect((await post(app, `/v1/departments/${id}/archive`)).status).toBe(200);
    expect(((await (await app.request("/v1/departments")).json()) as { departments: unknown[] }).departments).toEqual([]);
    const archived = await (await app.request("/v1/departments?include_archived=1")).json() as { departments: Array<{ archived: boolean }> };
    expect(archived.departments).toMatchObject([{ archived: true }]);
    expect((await post(app, `/v1/departments/${id}/restore`)).status).toBe(200);
    expect((await post(app, "/v1/departments/missing/archive")).status).toBe(404);
  });

  it("reports a broken stored settings row without failing the list", async () => {
    const { app, db } = makeApp();
    await post(app, "/v1/departments", { name: "開発部", slug: "dev" });
    db.prepare("UPDATE departments SET settings_json = '{broken'").run();
    const body = await (await app.request("/v1/departments")).json() as { departments: Array<{ settings: unknown; settings_error: string | null }> };
    expect(body.departments[0]).toMatchObject({ settings: null });
    expect(body.departments[0]?.settings_error).toBeTruthy();
  });
});
