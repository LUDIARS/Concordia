import { describe, expect, it, vi } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

interface HonoRouteDump {
  method: string;
  path: string;
}

function routesOf(app: unknown): string[] {
  const routes = (app as { routes?: HonoRouteDump[] }).routes ?? [];
  return routes.map((r) => `${r.method} ${r.path}`).sort();
}

describe("app route registration modes", () => {
  it("mounts core, chat, and cost routes by default", () => {
    const routes = routesOf(makeTestApp().app);
    expect(routes).toEqual(expect.arrayContaining([
      "GET /health",
      "GET /v1/sessions",
      "GET /v1/chat",
      "GET /v1/monitor",
      "GET /v1/taskflow/overview",
      "GET /v1/cost/overview",
      "GET /v1/admin/cost-budget",
      "POST /v1/admin/discord/start",
    ]));
  });

  it("omits chat routes when chatRoutes is disabled", async () => {
    const app = makeTestApp({ chatRoutes: false }).app;
    const routes = routesOf(app);
    expect(routes).toContain("GET /v1/sessions");
    expect(routes.some((r) => r.includes("/v1/chat"))).toBe(false);
    expect(routes.some((r) => r.includes("/v1/monitor"))).toBe(false);
    expect(routes.some((r) => r.includes("/v1/admin/discord"))).toBe(false);
    expect((await app.request("/v1/chat", { headers: { host: 'localhost' } })).status).toBe(404);
  });

  it("omits cost routes when costRoutes is disabled", async () => {
    const app = makeTestApp({ costRoutes: false }).app;
    const routes = routesOf(app);
    expect(routes).toContain("GET /v1/sessions");
    expect(routes.some((r) => r.includes("/v1/cost"))).toBe(false);
    expect(routes.some((r) => r.includes("/v1/cost-feed"))).toBe(false);
    expect(routes.some((r) => r.includes("/v1/admin/cost-budget"))).toBe(false);
    expect((await app.request("/v1/cost/overview", { headers: { host: 'localhost' } })).status).toBe(404);
  });
  it('mounts the browser guard before administrative effects', async () => {
    const { app, processManager } = makeTestApp();
    const start = vi.spyOn(processManager, 'startOne');
    try {
      const rejectedHeaders: Record<string, string>[] = [
        { host: 'evil.invalid', 'content-type': 'application/json' },
        { host: 'localhost', origin: 'https://evil.invalid', 'content-type': 'application/json' },
      ];
      for (const headers of rejectedHeaders) {
        expect((await app.request('/v1/admin/spawn-session', { method: 'POST', headers, body: '{}' })).status).toBe(403);
      }
      expect((await app.request('/v1/admin/spawn-session', { method: 'POST', headers: { host: 'localhost', 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); }
  });
});
