import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { seedModelCatalog } from "./seed.js";

describe("seedModelCatalog", () => {
  it("seeds Sonnet 5 on a fresh catalog", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    seedModelCatalog(repo);
    expect(repo.list().map((m) => m.model_id)).toContain("claude-sonnet-5");
  });

  it("adds rolling new models to an existing catalog without restoring ordinary seeds", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "codex", model_id: "custom-model" });

    seedModelCatalog(repo);

    const ids = repo.list({ includeInactive: true }).map((m) => m.model_id);
    expect(ids).toContain("custom-model");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).not.toContain("claude-opus-4-8");
  });

  it("demotes an existing Sonnet 4.6 row behind Sonnet 5 without recreating deleted rows", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "claude", model_id: "claude-sonnet-4-6", label: "Sonnet 4.6", sort_order: 20 });

    seedModelCatalog(repo);

    const rows = repo.list({ includeInactive: true });
    expect(rows.find((m) => m.model_id === "claude-sonnet-5")?.sort_order).toBe(20);
    expect(rows.find((m) => m.model_id === "claude-sonnet-4-6")?.sort_order).toBe(22);
    expect(rows.map((m) => m.model_id)).not.toContain("claude-opus-4-8");
  });
});
