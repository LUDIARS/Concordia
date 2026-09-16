// @augur test: session registration persists through the HTTP boundary
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../../helpers/test-app.js";

describe("session-coordination block", () => {
  it("registers an HTTP session and persists its ownership record", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "block-session", provider: "codex-cli", repo_path: "/work", host: "fixture", branch: "feat/block" }),
    });
    expect(response.status).toBe(200);
    expect(env.repo.findSession("block-session")).toMatchObject({ branch: "feat/block", repo_path: "/work" });
  });
});
