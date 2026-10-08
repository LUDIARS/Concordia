import { describe, expect, it } from "vitest";
import { makeTestApp } from "./test-app.js";

const path = "/v1/delegation/templates";
const body = JSON.stringify({ call_name: "local-fixture", title: "fixture", target_provider: "codex", prompt_template: "work" });

describe("local test app request boundary", () => {
  it("supplies the local Host for ordinary relative requests", async () => {
    const env = makeTestApp({ delegationSpawn: () => ({ ok: true, pid: null, command: ["mock"] }) });
    const response = await env.app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(201);
    expect(env.delegation.listTemplates().some(row => row.call_name === "local-fixture")).toBe(true);
  });

  for (const [name, headers] of [
    ["empty Host", { host: "" }],
    ["hostile Host", { host: "attacker.example" }],
    ["hostile Origin", { host: "localhost", origin: "https://attacker.example" }],
  ] as const) {
    it(`preserves rejection of ${name} with zero writes`, async () => {
      const env = makeTestApp();
      const response = await env.app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
      expect(response.status).toBe(403);
      expect(env.delegation.listTemplates().some(row => row.call_name === "local-fixture")).toBe(false);
    });
  }

  it("preserves missing Host in an explicit Request with zero writes", async () => {
    const env = makeTestApp();
    const request = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const response = await env.app.request(request);
    expect(response.status).toBe(403);
    expect(env.delegation.listTemplates().some(row => row.call_name === "local-fixture")).toBe(false);
  });

  it("preserves missing Host on absolute URL input", async () => {
    const env = makeTestApp();
    const response = await env.app.request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(response.status).toBe(403);
    expect(env.delegation.listTemplates().some(row => row.call_name === "local-fixture")).toBe(false);
  });

  for (const [name, headers] of [
    ["missing Content-Type", {}],
    ["simple form Content-Type", { "content-type": "application/x-www-form-urlencoded" }],
  ] as const) {
    it(`preserves rejection of ${name} with zero writes`, async () => {
      const env = makeTestApp();
      const response = await env.app.request(path, { method: "POST", headers });
      expect(response.status).toBe(415);
      expect(env.delegation.listTemplates().some(row => row.call_name === "local-fixture")).toBe(false);
    });
  }
});
