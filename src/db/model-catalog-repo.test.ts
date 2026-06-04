import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./schema.js";
import { ModelCatalogRepo } from "./model-catalog-repo.js";

describe("ModelCatalogRepo", () => {
  let db: Database.Database;
  let repo: ModelCatalogRepo;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = new ModelCatalogRepo(db);
  });

  afterEach(() => db.close());

  it("creates and lists active models sorted by sort_order", () => {
    repo.create({ model_id: "b", provider: "claude", sort_order: 20 });
    repo.create({ model_id: "a", provider: "claude", sort_order: 10 });
    const list = repo.list();
    expect(list.map((m) => m.model_id)).toEqual(["a", "b"]);
  });

  it("hides inactive models from default list, shows with includeInactive", () => {
    const m = repo.create({ model_id: "x", provider: "any" });
    repo.update(m.id, { is_active: false });
    expect(repo.list()).toHaveLength(0);
    expect(repo.list({ includeInactive: true })).toHaveLength(1);
  });

  it("upsert is idempotent on (provider, model_id)", () => {
    repo.upsert({ model_id: "dup", provider: "codex", label: "first" });
    repo.upsert({ model_id: "dup", provider: "codex", label: "second" });
    const list = repo.list({ includeInactive: true });
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("second");
  });

  it("same model_id under different providers is allowed", () => {
    repo.upsert({ model_id: "shared", provider: "claude" });
    repo.upsert({ model_id: "shared", provider: "codex" });
    expect(repo.list({ includeInactive: true })).toHaveLength(2);
  });

  it("rejects duplicate (provider, model_id) on create", () => {
    repo.create({ model_id: "dup", provider: "any" });
    expect(() => repo.create({ model_id: "dup", provider: "any" })).toThrow();
  });

  it("updates fields and removes rows", () => {
    const m = repo.create({ model_id: "old", provider: "any", label: "L" });
    const updated = repo.update(m.id, { model_id: "new", label: "L2" });
    expect(updated?.model_id).toBe("new");
    expect(updated?.label).toBe("L2");
    expect(repo.remove(m.id)).toBe(true);
    expect(repo.find(m.id)).toBeNull();
  });
});
