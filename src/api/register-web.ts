import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function registerWebRoutes(app: Hono): void {
  const webConfigPath = resolve(process.cwd(), "concordia.config.json");

  function readWebHosts(): string[] {
    if (!existsSync(webConfigPath)) return [];
    try {
      const cfg = JSON.parse(readFileSync(webConfigPath, "utf8")) as { web?: { allowedHosts?: unknown } };
      const hosts = cfg?.web?.allowedHosts;
      return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
    } catch {
      return [];
    }
  }

  function writeWebHosts(hosts: string[]): void {
    let cfg: Record<string, unknown> = {};
    if (existsSync(webConfigPath)) {
      try {
        cfg = JSON.parse(readFileSync(webConfigPath, "utf8")) as Record<string, unknown>;
      } catch {
        // Ignore malformed config and overwrite just the web section below.
      }
    }
    const web = (cfg.web && typeof cfg.web === "object" && !Array.isArray(cfg.web))
      ? { ...(cfg.web as Record<string, unknown>) }
      : {} as Record<string, unknown>;
    web.allowedHosts = hosts;
    cfg.web = web;
    writeFileSync(webConfigPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  }

  app.get("/v1/admin/web-hosts", (c) => c.json({ allowed_hosts: readWebHosts() }));

  app.put("/v1/admin/web-hosts", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.allowed_hosts)) {
      return c.json({ error: "body.allowed_hosts (string[]) required" }, 400);
    }
    const hosts = (body.allowed_hosts as unknown[]).filter((h): h is string => typeof h === "string");
    writeWebHosts(hosts);
    return c.json({ allowed_hosts: readWebHosts(), note: "Vite dev server restart required" });
  });

  const webDistRoot = "./web/dist";
  const webIndexPath = resolve(process.cwd(), "web/dist/index.html");
  if (existsSync(webIndexPath)) {
    const indexHtml = readFileSync(webIndexPath, "utf8");
    app.use("/*", serveStatic({ root: webDistRoot }));
    app.get("*", (c) => {
      const p = c.req.path;
      if (p.startsWith("/v1") || p === "/health") return c.notFound();
      return c.html(indexHtml);
    });
  }
}
