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
});
