// @augur test: delegation template creation persists through the HTTP boundary
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../../helpers/test-app.js";

describe("agent-delegation block", () => {
  it("accepts a template request and stores it for the mocked spawn adapter", async () => {
    const env = makeTestApp({ delegationSpawn: () => ({ ok: true, pid: null, command: ["mock"] }) });
    const response = await env.app.request("/v1/delegation/templates", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ call_name: "block-template", title: "block", target_provider: "codex", prompt_template: "work" }),
    });
    expect(response.status).toBe(201);
    expect(env.delegation.listTemplates().some((template) => template.call_name === "block-template")).toBe(true);
  });
});
