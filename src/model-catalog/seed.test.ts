import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { seedModelCatalog } from "./seed.js";

describe("seedModelCatalog", () => {
  it("keeps GPT-6 choices active and retires existing Sol/Luna 5.6 across reseeding", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    for (const name of ["sol", "terra", "luna"]) {
      repo.create({ provider: "codex", model_id: `gpt-5.6-${name}` });
    }
    seedModelCatalog(repo);
    seedModelCatalog(repo);
    const active = repo.list().map((row) => row.model_id);
    expect(active).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]));
    expect(active).not.toContain("gpt-5.6-sol");
    expect(active).not.toContain("gpt-5.6-luna");
    expect(active).not.toContain("gpt-5.6-terra");
    expect(repo.list({ includeInactive: true }).filter((row) => row.model_id === "gpt-6.1-sol")).toHaveLength(1);
  });

  it("seeds current Claude models on a fresh catalog", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    seedModelCatalog(repo);
    const ids = repo.list().map((m) => m.model_id);
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("claude-fable-5-1");
  });

  it("adds rolling new models to an existing catalog without restoring ordinary seeds", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "codex", model_id: "custom-model" });

    seedModelCatalog(repo);

    const ids = repo.list({ includeInactive: true }).map((m) => m.model_id);
    expect(ids).toContain("custom-model");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("claude-fable-5-1");
    // 新規公開モデルは既存 catalog (= 稼働中の DB) にも届く必要がある。
    expect(ids).toContain("gpt-6-astra");
    expect(ids).not.toContain("claude-opus-4-8");
  });

  it("deactivates existing Opus 5 / 4.8 rows when adding Opus 5.5", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "claude", model_id: "claude-opus-5", label: "Opus 5", sort_order: 10 });
    repo.create({ provider: "claude", model_id: "claude-opus-4-8", label: "Opus 4.8", sort_order: 90 });

    seedModelCatalog(repo);

    const rows = repo.list({ includeInactive: true });
    expect(rows.find((m) => m.model_id === "claude-opus-5-5")).toMatchObject({
      label: "Opus 5.5",
      sort_order: 10,
      is_active: 1,
    });
    expect(rows.find((m) => m.model_id === "claude-opus-5")).toMatchObject({
      sort_order: 90,
      is_active: 0,
    });
    expect(rows.find((m) => m.model_id === "claude-opus-4-8")).toMatchObject({
      sort_order: 91,
      is_active: 0,
    });
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
