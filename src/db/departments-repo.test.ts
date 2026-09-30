import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DepartmentsRepo } from "./departments-repo.js";
import { applyMigrations } from "./schema.js";
import { EMPTY_DEPARTMENT_SETTINGS } from "../departments/settings.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function makeRepo(): { db: Database.Database; repo: DepartmentsRepo } {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  return { db, repo: new DepartmentsRepo(db) };
}

const settings = { ...EMPTY_DEPARTMENT_SETTINGS, launch: { provider: "codex" }, projects: ["infra"] };

describe("DepartmentsRepo", () => {
  it("stores settings as JSON and lists per organization in display order", () => {
    const { repo } = makeRepo();
    const ops = repo.create({ subsidiary_id: null, name: "運用部", slug: "ops", settings, sort_order: 2 }, 10);
    const dev = repo.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings, sort_order: 1 }, 10);
    const child = repo.create({ subsidiary_id: "glab", name: "開発部", slug: "dev", settings }, 10);

    expect(JSON.parse(ops.settings_json)).toEqual(settings);
    expect(repo.listForOrganization(null).map((row) => row.id)).toEqual([dev.id, ops.id]);
    expect(repo.listForOrganization("glab").map((row) => row.id)).toEqual([child.id]);
    expect(repo.listAll().map((row) => row.id)).toEqual([child.id, dev.id, ops.id]);
    expect(repo.findBySlug("glab", "dev")?.id).toBe(child.id);
    expect(repo.findBySlug(null, "dev")?.id).toBe(dev.id);
  });

  it("enforces slug uniqueness per organization at the storage level", () => {
    const { repo } = makeRepo();
    repo.create({ subsidiary_id: null, name: "開発部", slug: "dev", settings });
    expect(() => repo.create({ subsidiary_id: null, name: "別", slug: "dev", settings })).toThrow();
    expect(() => repo.create({ subsidiary_id: "glab", name: "別", slug: "dev", settings })).not.toThrow();
  });

  it("patches only given fields and keeps ownership", () => {
    const { repo } = makeRepo();
    const row = repo.create({ subsidiary_id: "glab", name: "開発部", slug: "dev", settings }, 10);
    const patched = repo.patch(row.id, { rules_text: "PR は Revisor 経由" }, 20)!;
    expect(patched).toMatchObject({ subsidiary_id: "glab", name: "開発部", rules_text: "PR は Revisor 経由", updated_at: 20 });
    expect(repo.patch("missing", { name: "x" })).toBeNull();
  });

  it("hides archived departments unless asked and archives idempotently", () => {
    const { repo } = makeRepo();
    const row = repo.create({ subsidiary_id: null, name: "旧部", slug: "old", settings }, 10);
    expect(repo.setArchived(row.id, true, 30)?.archived_at).toBe(30);
    expect(repo.setArchived(row.id, true, 40)?.archived_at).toBe(30);
    expect(repo.listForOrganization(null)).toEqual([]);
    expect(repo.listForOrganization(null, { includeArchived: true }).map((d) => d.id)).toEqual([row.id]);
    expect(repo.listAll()).toEqual([]);
    expect(repo.setArchived(row.id, false, 50)?.archived_at).toBeNull();
  });

  it("adds a nullable department_id to sessions, runs, teams and harness rules", () => {
    const { db } = makeRepo();
    for (const table of ["sessions", "delegation_runs", "teams", "harness_rules"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
      expect(columns.find((column) => column.name === "department_id"), table).toMatchObject({ notnull: 0 });
    }
  });
});
