import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function registerWebRoutes(app: Hono): void {
  const webConfigPath = resolve(process.cwd(), "concordia.config.json");
  // Async read-modify-write must stay serialized. The previous sync implementation
  // could not interleave two requests on the event loop; preserving that property
  // prevents one PUT from restoring the stale non-web sections read by another.
  let webConfigWrites: Promise<void> = Promise.resolve();

  async function readWebConfig(): Promise<Record<string, unknown> | null> {
    let raw: string;
    try {
      raw = await readFile(webConfigPath, "utf8");
    } catch {
      return null;
    }
    return JSON.parse(raw) as Record<string, unknown>;
  }

  async function readWebHosts(): Promise<string[]> {
    // Do not observe a config file while an in-process write may have truncated it.
    await webConfigWrites.catch(() => undefined);
    try {
      const cfg = (await readWebConfig()) as { web?: { allowedHosts?: unknown } } | null;
      const hosts = cfg?.web?.allowedHosts;
      return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
    } catch {
      return [];
    }
  }

  async function writeWebHosts(hosts: string[]): Promise<void> {
    const write = webConfigWrites.catch(() => undefined).then(async () => {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = (await readWebConfig()) ?? {};
      } catch {
        // Ignore malformed config and overwrite just the web section below.
      }
      const web = (cfg.web && typeof cfg.web === "object" && !Array.isArray(cfg.web))
        ? { ...(cfg.web as Record<string, unknown>) }
        : {} as Record<string, unknown>;
      web.allowedHosts = hosts;
      cfg.web = web;
      await writeFile(webConfigPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    });
    webConfigWrites = write;
    await write;
  }

  app.get("/v1/admin/web-hosts", async (c) => c.json({ allowed_hosts: await readWebHosts() }));

  app.put("/v1/admin/web-hosts", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.allowed_hosts)) {
      return c.json({ error: "body.allowed_hosts (string[]) required" }, 400);
    }
    const hosts = (body.allowed_hosts as unknown[]).filter((h): h is string => typeof h === "string");
    await writeWebHosts(hosts);
    return c.json({ allowed_hosts: hosts, note: "Vite dev server restart required" });
  });

  // Boot-time only: the SPA shell is read once while routes are registered.
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
