import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { registerAgentInstructionsRoute } from "../api/agent-instructions.js";
import { createAgentInstructionsRuntime } from "./runtime.js";

const KEY = "r".repeat(40);

function build(read: () => string | null, env: Record<string, string> = {}) {
  const runtime = createAgentInstructionsRuntime(makeTestDb(), env, read);
  const app = new Hono();
  registerAgentInstructionsRoute(app, runtime.routes);
  return { runtime, app };
}

describe("agent instructions runtime", () => {
  it("wires the store, gate and sweep (public rejected while the key is unset)", async () => {
    const { runtime, app } = build(() => null);
    const created = await app.request("/v1/instructions", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ agent: "muse", type: "notify_only", title: "t", body: "b" }),
    });
    expect(created.status).toBe(201);
    expect((await app.request("/v1/instructions?agent=muse", { headers: { host: "127.0.0.1" } })).status).toBe(200);
    expect((await app.request("/v1/instructions?agent=muse", { headers: { host: "127.0.0.1", "cf-ray": "x", "x-excubitor-token": KEY } })).status).toBe(401);
    expect(() => runtime.sweep()).not.toThrow();
  });

  it("reads the stored key on each public request and treats a read failure as closed", async () => {
    let stored: string | null = KEY;
    let fail = false;
    const { runtime, app } = build(() => { if (fail) throw new Error("cannot decrypt"); return stored; }, { CONCORDIA_INSTRUCTIONS_PUBLIC_HOST: "cc-home.ai-run-do.com" });
    const poll = () => app.request("/v1/instructions?agent=muse", { headers: { host: "cc-home.ai-run-do.com", "x-excubitor-token": KEY } });
    expect(runtime.routes.access.origin((name) => (name === "host" ? "cc-home.ai-run-do.com" : undefined))).toBe("public");
    expect((await poll()).status).toBe(200);
    fail = true;
    expect((await poll()).status).toBe(401);
    fail = false;
    stored = null;
    expect((await poll()).status).toBe(401);
  });
});
