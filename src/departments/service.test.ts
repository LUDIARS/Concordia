import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DepartmentsRepo } from "../db/departments-repo.js";
import { applyMigrations } from "../db/schema.js";
import { DepartmentService, type DepartmentChange } from "./service.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function makeService() {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const repo = new DepartmentsRepo(db);
  const changes: DepartmentChange[] = [];
  const service = new DepartmentService({
    repo,
    organizations: {
      exists: (id) => id === "glab",
      projects: (id) => (id === "glab" ? ["glab-web", "glab-api"] : []),
    },
    useCases: { isAssignable: (id) => id === "uc-qa" },
    onChange: (change) => changes.push(change),
    now: () => 1_000,
  });
  return { service, repo, changes };
}

const settings = { launch: {}, projects: [] };

describe("DepartmentService", () => {
  it("creates head-office and subsidiary departments with the same slug", () => {
    const { service, changes } = makeService();
    const head = service.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings });
    const child = service.create({ subsidiary_id: "glab", name: "開発部", slug: "dev", settings: { launch: {}, projects: ["glab-web"] } });
    expect(head).toMatchObject({ ok: true, department: { subsidiary_id: null, created_at: 1_000 } });
    expect(child).toMatchObject({ ok: true, department: { subsidiary_id: "glab" } });
    expect(changes.map((change) => change.action)).toEqual(["created", "created"]);
  });

  it("rejects a duplicate slug within one organization", () => {
    const { service } = makeService();
    service.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings });
    expect(service.create({ subsidiary_id: null, name: "開発二部", slug: "dev", settings }))
      .toEqual({ ok: false, error: "department_slug_taken" });
  });

  it("rejects an unknown subsidiary and projects outside its scope (CC-DEPT-INV-03)", () => {
    const { service, changes } = makeService();
    expect(service.create({ subsidiary_id: "nope", name: "x", slug: "x", settings }))
      .toEqual({ ok: false, error: "subsidiary_not_found" });
    expect(service.create({ subsidiary_id: "glab", name: "x", slug: "x", settings: { launch: {}, projects: ["Concordia"] } }))
      .toEqual({ ok: false, error: "department_projects_outside_subsidiary_scope", outside: ["Concordia"] });
    expect(changes).toEqual([]);
  });

  it("checks the subsidiary scope again when settings are updated", () => {
    const { service } = makeService();
    const created = service.create({ subsidiary_id: "glab", name: "開発部", slug: "dev", settings });
    if (!created.ok) throw new Error("setup failed");
    expect(service.update(created.department.id, { settings: { launch: {}, projects: ["Concordia"] } }))
      .toMatchObject({ ok: false, error: "department_projects_outside_subsidiary_scope" });
    expect(service.update(created.department.id, { name: "開発本部" })).toMatchObject({ ok: true, department: { name: "開発本部" } });
  });

  it("rejects renaming to a slug held by another department", () => {
    const { service } = makeService();
    service.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings });
    const ops = service.create({ subsidiary_id: null, name: "運用部", slug: "ops", settings });
    if (!ops.ok) throw new Error("setup failed");
    expect(service.update(ops.department.id, { slug: "dev" })).toEqual({ ok: false, error: "department_slug_taken" });
    expect(service.update(ops.department.id, { slug: "ops" })).toMatchObject({ ok: true });
  });

  it("keeps a single default department per organization (departments.md §9.2)", () => {
    const { service, repo } = makeService();
    const general = service.create({ subsidiary_id: null, name: "総務", slug: "general", is_default: true });
    const qa = service.create({ subsidiary_id: null, name: "技術相談課", slug: "qa" });
    const child = service.create({ subsidiary_id: "glab", name: "総務", slug: "general", is_default: true });
    if (!general.ok || !qa.ok || !child.ok) throw new Error("setup failed");
    expect(repo.findDefault(null)?.id).toBe(general.department.id);

    service.update(qa.department.id, { is_default: true });
    expect(repo.findDefault(null)?.id).toBe(qa.department.id);
    expect(repo.find(general.department.id)?.is_default).toBe(0);
    expect(repo.findDefault("glab")?.id).toBe(child.department.id);
  });

  it("clears the default when archiving and refuses to make an archived department default", () => {
    const { service, repo } = makeService();
    const general = service.create({ subsidiary_id: null, name: "総務", slug: "general", is_default: true });
    if (!general.ok) throw new Error("setup failed");
    service.setArchived(general.department.id, true);
    expect(repo.findDefault(null)).toBeNull();
    expect(service.update(general.department.id, { is_default: true })).toEqual({ ok: false, error: "department_archived" });
  });

  it("only assigns use cases that exist and are active", () => {
    const { service } = makeService();
    expect(service.create({ subsidiary_id: null, name: "技術相談課", slug: "qa", use_case_id: "uc-qa" }))
      .toMatchObject({ ok: true, department: { use_case_id: "uc-qa" } });
    expect(service.create({ subsidiary_id: null, name: "x", slug: "x", use_case_id: "uc-missing" }))
      .toEqual({ ok: false, error: "use_case_not_assignable" });
  });

  it("validates settings and stores defaults for omitted output items", () => {
    const { service, repo } = makeService();
    expect(service.create({ subsidiary_id: null, name: "x", slug: "x", settings: { output: { thinking: "loud" } } as never }))
      .toMatchObject({ ok: false, error: "invalid_department_settings" });
    const created = service.create({ subsidiary_id: null, name: "y", slug: "y", settings: { output: { thinking: "off" } } });
    if (!created.ok) throw new Error("setup failed");
    expect(JSON.parse(repo.find(created.department.id)!.settings_json)).toEqual({
      launch: {}, projects: [], output: { thinking: "off", status_card: "inherit", session_info_card: "inherit", cost_report: "inherit" },
    });
  });

  it("archives and restores idempotently, emitting only real changes", () => {
    const { service, changes } = makeService();
    const created = service.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings });
    if (!created.ok) throw new Error("setup failed");
    const id = created.department.id;
    expect(service.setArchived(id, true)).toMatchObject({ ok: true, department: { archived_at: 1_000 } });
    expect(service.setArchived(id, true)).toMatchObject({ ok: true });
    expect(service.setArchived(id, false)).toMatchObject({ ok: true, department: { archived_at: null } });
    expect(changes.map((change) => change.action)).toEqual(["created", "archived", "restored"]);
    expect(service.setArchived("missing", true)).toEqual({ ok: false, error: "department_not_found" });
  });
});
