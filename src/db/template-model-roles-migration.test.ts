import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "./delegation-repo.js";
import { migrateTemplateModelsToRoles } from "./template-model-roles-migration.js";

function template(repo: DelegationRepo, call_name: string, target_provider: string, model: string | null) {
  return repo.createTemplate({ call_name, title: call_name, target_provider: target_provider as "claude", model, prompt_template: "x" });
}

describe("migrateTemplateModelsToRoles (migration 148)", () => {
  it("moves Claude and Codex model IDs to role names", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const rows = {
      opus: template(repo, "t-opus", "claude", "claude-opus-5-5"),
      opus1m: template(repo, "t-opus-1m", "claude", "claude-opus-5-5[1m]"),
      sonnet: template(repo, "t-sonnet", "claude", "claude-sonnet-5"),
      haiku: template(repo, "t-haiku", "claude", "claude-haiku-4-5-20251001"),
      fable: template(repo, "t-fable", "claude", "claude-fable-5-1"),
      sol: template(repo, "t-sol", "codex", "gpt-6.2-sol"),
      astra: template(repo, "t-astra", "codex-sdk", "gpt-6-astra"),
      luna: template(repo, "t-luna", "codex", "gpt-6-luna"),
      terra: template(repo, "t-terra", "codex", "gpt-5.6-terra"),
    };
    migrateTemplateModelsToRoles(db);
    const model = (id: string) => repo.findTemplate(id)?.model;
    expect(model(rows.opus.id)).toBe("opus");
    expect(model(rows.opus1m.id)).toBe("opus[1m]");
    expect(model(rows.sonnet.id)).toBe("sonnet");
    expect(model(rows.haiku.id)).toBe("haiku");
    expect(model(rows.fable.id)).toBe("fable");
    expect(model(rows.sol.id)).toBe("sol");
    expect(model(rows.astra.id)).toBe("astra");
    expect(model(rows.luna.id)).toBe("luna");
    expect(model(rows.terra.id)).toBe("luna");
  });

  it("leaves other providers, unknown IDs and a pinned sol-6-1 untouched", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const mismatched = template(repo, "t-mismatch", "codex", "claude-opus-5-5");
    const local = template(repo, "t-local", "gemma4-12", "auto");
    const other = template(repo, "t-other", "codex", "gpt-5.3-codex");
    const pinned = template(repo, "sol-6-1", "codex", "gpt-6.1-sol");
    migrateTemplateModelsToRoles(db);
    expect(repo.findTemplate(mismatched.id)?.model).toBe("claude-opus-5-5");
    expect(repo.findTemplate(local.id)?.model).toBe("auto");
    expect(repo.findTemplate(other.id)?.model).toBe("gpt-5.3-codex");
    expect(repo.findTemplate(pinned.id)?.model).toBe("gpt-6.1-sol");
  });

  it("migrates a sol-6-1 row that still follows the role", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const following = template(repo, "sol-6-1", "codex", "gpt-6.2-sol");
    repo.trackTemplateModel(following.id);
    migrateTemplateModelsToRoles(db);
    expect(repo.findTemplate(following.id)?.model).toBe("sol");
  });
});
