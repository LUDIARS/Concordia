import { describe, expect, it } from "vitest";
import { renderCcWorkflowStartupInject } from "./collaboration-context.js";

describe("Cc workflow startup inject", () => {
  it("renders the same startup packet identity and session-scoped task API", () => {
    const text = renderCcWorkflowStartupInject("session/a");
    expect(text).toContain("[concordia/cc-workflow]");
    expect(text).toContain("/v1/sessions/session%2Fa/event");
    expect(text).toContain("register that branch in Cc before editing");
    // Taskflow v3.0: タスク正本は Actio。 task md の path は案内しない。
    expect(text).not.toContain("spec/tasks/");
    expect(text).toContain("タスクは Actio で参照してください");
    expect(text).toContain("PR タイトル・本文は変更内容と検証範囲を日本語で記録");
  });
});
