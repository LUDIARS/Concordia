import { describe, expect, it } from "vitest";
import { renderCcWorkflowStartupInject } from "./collaboration-context.js";
import { buildEscalationCcWorkflow } from "./escalation-workflow.js";
import { majorInjectDefinition } from "./major-inject-catalog.js";

describe("editable workflow Inject defaults", () => {
  it("normal mode renders edited rules while preserving mode and task API", () => {
    const defaultRules = majorInjectDefinition("session.workflow.normal")?.default_content;
    expect(defaultRules).toBeDefined();
    const rendered = renderCcWorkflowStartupInject("session/42", (id) =>
      id === "session.workflow.normal" ? `Edited normal rules\n${defaultRules}` : null);
    const packet = JSON.parse(rendered.split("\n").slice(1).join("\n")) as {
      inject_source: string; rules: string[]; task_api: { list_todos: string };
    };
    expect(packet.inject_source).toBe("session-start:cc-workflow");
    expect(packet.rules[0]).toBe("Edited normal rules");
    expect(packet.task_api.list_todos).toContain("session%2F42");
  });

  it("escalation mode renders edited rules and the current reason and release endpoint", () => {
    const defaultRules = majorInjectDefinition("session.workflow.escalation")?.default_content;
    expect(defaultRules).toBeDefined();
    const packet = buildEscalationCcWorkflow(
      "session/42", { reason: "service outage", started_at: 1, actor: "operator" },
      (id) => id === "session.workflow.escalation" ? `Edited escalation rules\n${defaultRules}` : null,
    );
    expect(packet.inject_source).toBe("escalation:cc-workflow");
    expect(packet.rules[0]).toBe("Edited escalation rules");
    expect(packet.rules.join("\n")).toContain("service outage");
    expect(packet.rules.join("\n")).toContain("DELETE /v1/sessions/session%2F42/escalation");
    expect(packet.task_api.list_pending).toContain("session%2F42");
  });
});
