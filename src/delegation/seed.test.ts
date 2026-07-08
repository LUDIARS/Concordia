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
});
