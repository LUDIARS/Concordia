import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ModelCatalogRepo } from "../db/model-catalog-repo.js";
import { INITIAL_CLAUDE_ROLE_MODELS, INITIAL_GEMINI_ROLE_MODELS, INITIAL_GROK_ROLE_MODELS, INITIAL_ROLE_MODELS } from "./role-policy.js";
import { buildRoleMap } from "./role-map.js";
import { currentRoleSeedModels, seedModelCatalog } from "./seed.js";

describe("seedModelCatalog", () => {
  it("keeps the current seed rows equal to the role-policy values", () => {
    const seeded = currentRoleSeedModels().map((row) => row.model_id).sort();
    const policy = [
      ...Object.values(INITIAL_CLAUDE_ROLE_MODELS), ...Object.values(INITIAL_ROLE_MODELS), ...Object.values(INITIAL_GEMINI_ROLE_MODELS),
      ...Object.values(INITIAL_GROK_ROLE_MODELS),
    ].sort();
    expect(seeded).toEqual(policy);
  });

  it("builds a role map equal to role-policy from a freshly seeded catalog", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    seedModelCatalog(repo);
    const map = buildRoleMap({ roles: [], catalog: repo.list(), nowMs: 0 });
    expect(map.roles.claude).toEqual(INITIAL_CLAUDE_ROLE_MODELS);
    expect(map.roles.gemini).toEqual(INITIAL_GEMINI_ROLE_MODELS);
    expect(map.roles.grok).toEqual(INITIAL_GROK_ROLE_MODELS);
  });

  it("adds the Gemini neon row to an existing catalog and keeps the older Gemini rows", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "gemini", model_id: "gemini-2.5-pro", sort_order: 10 });
    seedModelCatalog(repo);
    const rows = repo.list({ includeInactive: true });
    expect(rows.find((m) => m.model_id === INITIAL_GEMINI_ROLE_MODELS.neon))
      .toMatchObject({ provider: "gemini", label: "Gemini 4 Neon", sort_order: 5, is_active: 1 });
    // Argon も gemini 行 (agy 専用行は作らない)。 既定は Neon なので並びは Neon が先 (MRM-GEM-05)。
    expect(rows.find((m) => m.model_id === INITIAL_GEMINI_ROLE_MODELS.argon))
      .toMatchObject({ provider: "gemini", label: "Gemini 4 Argon", sort_order: 6, is_active: 1 });
    expect(rows.some((m) => (m.provider as string) === "agy")).toBe(false);
    expect(rows.find((m) => m.model_id === "gemini-2.5-pro")).toMatchObject({ is_active: 1 });
  });

  it("retires existing older-generation rows across reseeding", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    for (const name of ["sol", "terra", "luna"]) {
      repo.create({ provider: "codex", model_id: `gpt-5.6-${name}` });
    }
    repo.create({ provider: "codex", model_id: "gpt-6.1-sol" });
    repo.create({ provider: "claude", model_id: "claude-fable-5-1", sort_order: 24 });
    repo.create({ provider: "claude", model_id: "claude-haiku-4-5-20251001", sort_order: 30 });
    seedModelCatalog(repo);
    seedModelCatalog(repo);
    const active = repo.list().map((row) => row.model_id);
    expect(active).toEqual(expect.arrayContaining(["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-luna", "claude-fable-5-2", "claude-haiku-5-5"]));
    for (const retired of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6.1-sol", "claude-fable-5-1", "claude-haiku-4-5-20251001"]) {
      expect(active).not.toContain(retired);
    }
    expect(repo.list({ includeInactive: true }).filter((row) => row.model_id === "gpt-6.1-sol")).toHaveLength(1);
  });

  it("does not seed older-generation rows on a fresh catalog", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    seedModelCatalog(repo);
    const ids = repo.list({ includeInactive: true }).map((m) => m.model_id);
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-haiku-5-5"]));
    for (const old of ["claude-fable-5-1", "claude-fable-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "gpt-6-astra", "gpt-6.1-sol"]) {
      expect(ids).not.toContain(old);
    }
  });

  it("adds current models to an existing catalog without restoring ordinary seeds", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "codex", model_id: "custom-model" });

    seedModelCatalog(repo);

    const ids = repo.list({ includeInactive: true }).map((m) => m.model_id);
    expect(ids).toContain("custom-model");
    expect(ids).toContain("claude-opus-5-5");
    expect(ids).toContain("gpt-6.2-sol");
    expect(repo.list().filter((m) => m.provider === "grok")).toEqual([
      expect.objectContaining({ model_id: "grok-4.7", label: "Grok 4.7", sort_order: 7, is_active: 1 }),
    ]);
    expect(ids).not.toContain("claude-opus-4-8");
    expect(ids).not.toContain("gemini-2.5-pro");
  });

  it("deactivates existing Opus 5 / 4.8 and Sonnet 4.6 rows", () => {
    const repo = new ModelCatalogRepo(makeTestDb());
    repo.create({ provider: "claude", model_id: "claude-opus-5", label: "Opus 5", sort_order: 10 });
    repo.create({ provider: "claude", model_id: "claude-opus-4-8", label: "Opus 4.8", sort_order: 90 });
    repo.create({ provider: "claude", model_id: "claude-sonnet-4-6", label: "Sonnet 4.6", sort_order: 20 });

    seedModelCatalog(repo);

    const rows = repo.list({ includeInactive: true });
    expect(rows.find((m) => m.model_id === "claude-opus-5-5")).toMatchObject({ label: "Opus 5.5", sort_order: 10, is_active: 1 });
    expect(rows.find((m) => m.model_id === "claude-opus-5")).toMatchObject({ sort_order: 90, is_active: 0 });
    expect(rows.find((m) => m.model_id === "claude-opus-4-8")).toMatchObject({ sort_order: 91, is_active: 0 });
    expect(rows.find((m) => m.model_id === "claude-sonnet-4-6")).toMatchObject({ is_active: 0 });
  });
});
