import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWebRoutes } from "./register-web.js";

let dir: string | null = null;
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function app(): { app: Hono; config: string } {
  dir = mkdtempSync(join(tmpdir(), "cc-register-web-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  const hono = new Hono();
  registerWebRoutes(hono);
  return { app: hono, config: join(dir, "concordia.config.json") };
}

describe("/v1/admin/web-hosts", () => {
  it("reads nothing from a missing or malformed config", async () => {
    const { app: hono, config } = app();
    expect(await (await hono.request("/v1/admin/web-hosts")).json()).toEqual({ allowed_hosts: [] });
    writeFileSync(config, "{ broken");
    expect(await (await hono.request("/v1/admin/web-hosts")).json()).toEqual({ allowed_hosts: [] });
  });

  it("writes only the web section and keeps the rest of the config", async () => {
    const { app: hono, config } = app();
    writeFileSync(config, JSON.stringify({ other: 1, web: { port: 5173 } }));
    const res = await hono.request("/v1/admin/web-hosts", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ allowed_hosts: ["a.local", 3] }),
    });
    expect(await res.json()).toMatchObject({ allowed_hosts: ["a.local"] });
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ other: 1, web: { port: 5173, allowedHosts: ["a.local"] } });
  });

  it("rejects a body without allowed_hosts", async () => {
    const { app: hono } = app();
    const res = await hono.request("/v1/admin/web-hosts", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });

  it("serializes concurrent updates and returns each request's committed value", async () => {
    const { app: hono, config } = app();
    writeFileSync(config, JSON.stringify({ other: 1, web: { port: 5173 } }));
    const put = (host: string) => hono.request("/v1/admin/web-hosts", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed_hosts: [host] }),
    });

    const [first, second] = await Promise.all([put("first.local"), put("second.local")]);

    expect(await first.json()).toMatchObject({ allowed_hosts: ["first.local"] });
    expect(await second.json()).toMatchObject({ allowed_hosts: ["second.local"] });
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      other: 1,
      web: { port: 5173, allowedHosts: ["second.local"] },
    });
  });
});
