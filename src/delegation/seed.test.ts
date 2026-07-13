import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { seedDelegationTemplates } from "./seed.js";

describe("seedDelegationTemplates", () => {
  it("replaces the Sonnet 4.6 implementation template with Sonnet 5", () => {
    const repo = new DelegationRepo(makeTestDb());
    repo.createTemplate({
      call_name: "claude-sonnet-4-6-impl",
      title: "Old Sonnet",
      target_provider: "claude",
      model: "claude-sonnet-4-6",
      prompt_template: "old",
    });

    seedDelegationTemplates(repo);

    expect(repo.findTemplateByCallName("claude-sonnet-4-6-impl")?.is_active).toBe(0);
    const sonnet5 = repo.findTemplateByCallName("claude-sonnet-5-impl");
    expect(sonnet5?.is_active).toBe(1);
    expect(sonnet5?.model).toBe("claude-sonnet-5");
  });

  it("assigns employment categories to every seed template", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    // 代表例: spawn ワーカー = employee / caller 特化 = freelancer / 時限起動 = parttimer
    expect(repo.findTemplateByCallName("claude-sonnet-5-impl")?.category).toBe("employee");
    expect(repo.findTemplateByCallName("codex-5-6-sol")?.category).toBe("employee");
    expect(repo.findTemplateByCallName("impl-from-design")?.category).toBe("freelancer");
    expect(repo.findTemplateByCallName("review-sonnet5")?.category).toBe("freelancer");
    expect(repo.findTemplateByCallName("morning-tasks")?.category).toBe("parttimer");
    expect(repo.findTemplateByCallName("ludiars-review-daily")?.category).toBe("parttimer");
  });

  it("seeds the daily-review-reconciliation parttimer template", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const tpl = repo.findTemplateByCallName("daily-review-reconciliation");
    expect(tpl?.is_active).toBe(1);
    expect(tpl?.category).toBe("parttimer");
    expect(tpl?.target_provider).toBe("claude");
    // プロンプト正本 (LUDIARS/docs/REVIEW-PROMPTS.md) を参照させる — 本文の二重管理をしない。
    expect(tpl?.prompt_template).toContain("REVIEW-PROMPTS.md");
    expect(tpl?.prompt_template).toContain("service-map.json");
  });
});
