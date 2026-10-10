import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { seedDelegationTemplates } from "./seed.js";
import { renderTemplate } from "./prompt.js";
import { DAILY_GOAL_RUNNER_TEMPLATE } from "./daily-goal-runner-template.js";

describe("daily-goal-runner template", () => {
  it("is seeded as a call-only Opus 5.5 / medium employee template", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);
    const tpl = repo.findTemplateByCallName("daily-goal-runner");
    expect(tpl).toMatchObject({ category: "employee", model: "claude-opus-5-5", target_provider: "claude", call_only: 1 });
    expect(JSON.parse(tpl!.runtime_options_json)).toMatchObject({ effort: "medium" });
  });

  it("renders only the goal, acceptance, permissions, Actio tasks and the procedure", () => {
    const result = renderTemplate(DAILY_GOAL_RUNNER_TEMPLATE.prompt_template, {
      daily_goal_id: "g1", target_repo: "E:/repo", goal_text: "出荷", acceptance: "1. A", permissions: "マージ=不可",
      actio_tasks: "actio:t1", concordia_url: "http://cc",
    }, DAILY_GOAL_RUNNER_TEMPLATE.input_schema ?? []);
    expect(result.missing).toEqual([]);
    expect(result.unknown_vars).toEqual([]);
    expect(result.rendered).toContain("出荷");
    expect(result.rendered).toContain("http://cc/v1/daily-goals/g1/exhausted");
    expect(result.rendered).toContain("ask で聞いて止まる");
    expect(result.rendered).toContain("セッション外の task");
  });
});
