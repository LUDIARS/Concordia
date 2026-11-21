import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { registerAgentInstructionsRoute } from "../api/agent-instructions.js";
import { createAgentInstructionsRuntime } from "./runtime.js";

describe("agent instructions runtime", () => {
  it("wires the store, gate and sweep from env (public rejected when Access is unset)", async () => {
    const runtime = createAgentInstructionsRuntime(makeTestDb(), {});
    const app = new Hono();
    registerAgentInstructionsRoute(app, runtime.routes);
    const created = await app.request("/v1/instructions", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ agent: "muse", type: "notify_only", title: "t", body: "b" }),
    });
    expect(created.status).toBe(201);
    expect((await app.request("/v1/instructions?agent=muse", { headers: { host: "127.0.0.1" } })).status).toBe(200);
    expect((await app.request("/v1/instructions?agent=muse", { headers: { host: "127.0.0.1", "cf-ray": "x" } })).status).toBe(403);
    expect(() => runtime.sweep()).not.toThrow();
  });

  it("builds a JWT verifier when team and audience are configured", async () => {
    let fetched = "";
    const runtime = createAgentInstructionsRuntime(makeTestDb(), {
      CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: "cc-home.ai-run-do.com",
      CONCORDIA_INSTRUCTIONS_CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
      CONCORDIA_INSTRUCTIONS_CF_ACCESS_AUD: "d".repeat(64),
    }, { fetchJwks: async (url) => { fetched = url; return { keys: [] }; } });
    const header = (values: Record<string, string>) => (name: string) => values[name];
    expect(await runtime.routes.access.verifyPublic(header({ "cf-access-jwt-assertion": "a.b.c" }))).toBe(false);
    expect(runtime.routes.access.origin(header({ host: "cc-home.ai-run-do.com" }))).toBe("public");
    expect(fetched === "" || fetched === "https://example.cloudflareaccess.com/cdn-cgi/access/certs").toBe(true);
  });
});
