import { describe, expect, it } from "vitest";
import { renderCcWorkflowStartupInject } from "./collaboration-context.js";

describe("Cc workflow startup inject", () => {
  it("renders the same startup packet identity and session-scoped task API", () => {
    const text = renderCcWorkflowStartupInject("session/a");
    expect(text).toContain("[concordia/cc-workflow]");
    expect(text).toContain("/v1/sessions/session%2Fa/event");
    expect(text).toContain("register that branch in Cc before editing");
    expect(text).toContain("spec/tasks/");
    expect(text).toContain("PR タイトル、目的、完了条件を日本語で空欄なく記録");
  });
});
