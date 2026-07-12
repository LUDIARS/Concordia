import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

describe("removed dead API routes", () => {
  it.each([
    ["GET", "/v1/stream"],
    ["GET", "/v1/machines/host-a"],
    ["GET", "/v1/tasks/remaining"],
    ["POST", "/v1/personas/generate"],
    ["GET", "/v1/harness/blackbox"],
    ["POST", "/v1/harness/override"],
    ["POST", "/v1/processes"],
    ["POST", "/v1/processes/stop-all"],
    ["DELETE", "/v1/processes/anything"],
  ] as const)("returns 404 for %s %s", async (method, path) => {
    const env = makeTestApp();
    const response = await env.app.request(path, { method });
    expect(response.status).toBe(404);
  });

  it("keeps the read-only processes list", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/processes");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processes: [] });
  });

  it.each([
    ["GET", "/v1/spawn/recent"],
    ["POST", "/v1/spawn/preview"],
  ] as const)("removes authenticated spawn helper %s %s", async (method, path) => {
    const env = makeTestApp();
    const token = readFileSync(join(env.logsDir, ".spawn.token"), "utf8").trim();
    const response = await env.app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });
});
