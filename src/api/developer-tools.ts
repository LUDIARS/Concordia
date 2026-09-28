import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ToolInput, failure } from "../developer-tools/contracts.js";
import { toolCatalog } from "../developer-tools/catalog.js";
import type { DeveloperToolsService } from "../developer-tools/service.js";
import { listCommonCommands } from "../developer-tools/command-catalog.js";
import { listGeneratedScripts, resolveRegisteredRepo, type RegisteredProject } from "../developer-tools/script-catalog.js";

export interface CommandCatalogDeps {
  projects: () => RegisteredProject[];
  workspaceRoots: () => string[];
  ccRoot: string;
  commonCommands?: typeof listCommonCommands;
  generatedScripts?: typeof listGeneratedScripts;
}

export function developerToolsRouter(service: Pick<DeveloperToolsService, "execute">, catalog?: CommandCatalogDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/catalog", c => c.json(toolCatalog()));
  if (catalog) {
    app.get("/commands", async c => {
      try { return c.json({ commands: await (catalog.commonCommands ?? listCommonCommands)(catalog.ccRoot) }); }
      catch { return c.json({ error: "command_catalog_unavailable" }, 503); }
    });
    app.get("/scripts/projects", c => c.json({ projects: catalog.projects().map(({ code, project }) => ({ code, project })) }));
    app.get("/scripts", async c => {
      const code = c.req.query("code");
      if (!code) return c.json({ error: "project_code_required" }, 400);
      try {
        const repo = await resolveRegisteredRepo(code, catalog.projects(), catalog.workspaceRoots());
        return c.json({ code, scripts: await (catalog.generatedScripts ?? listGeneratedScripts)(catalog.ccRoot, repo) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "script_catalog_unavailable";
        if (reason === "project_code_not_found") return c.json({ error: reason }, 404);
        if (reason.startsWith("registered_repository_")) return c.json({ error: reason }, 409);
        return c.json({ error: "script_catalog_unavailable" }, 503);
      }
    });
  }
  app.post("/execute", bodyLimit({ maxSize: 32_000 }), async c => {
    const request = z.object({ session_id: z.string().min(1), input: ToolInput }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!request.success) return c.json({ ok: false, reason: "invalid_tool_input" }, 400);
    try {
      return c.json({ ok: true, result: await service.execute(request.data.session_id, request.data.input) });
    } catch (error) { return c.json(failure(error), 409); }
  });
  return app;
}
