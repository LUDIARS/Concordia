import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

describe("Cc workflow context injection", () => {
  it("returns startup workflow instructions with task API and PR completion policy", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ccwf",
        provider: "codex-cli",
        repo_path: "/work/Concordia",
        branch: "main",
        host: "host",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const workflow = body.context_packet.cc_workflow;
    expect(workflow.inject_source).toBe("session-start:cc-workflow");
    expect(workflow.task_api.update_todos).toContain("/v1/sessions/ccwf/event");
    expect(workflow.rules.join("\n")).toContain("task_update");
    expect(workflow.rules.join("\n")).toContain("open a PR");
    expect(workflow.interrupt_policy).toContain("append");
    expect(workflow.completion_policy.join("\n")).toContain("CI is green");
    expect(workflow.completion_policy.join("\n")).toContain("CI is red");
  });

  it("also exposes the same workflow through GET /context", async () => {
    const env = makeTestApp();
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ccwf-context",
        provider: "codex-cli",
        repo_path: "/work/Concordia",
        branch: "main",
        host: "host",
      }),
    });

    const response = await env.app.request("/v1/sessions/ccwf-context/context");
    const body = await response.json() as any;
    expect(body.context_packet.cc_workflow.task_api.list_pending).toContain("/pending-tasks");
  });
});
