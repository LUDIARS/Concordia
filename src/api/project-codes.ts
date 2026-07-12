import { Hono } from "hono";
import { loadProjectCodes } from "../projects/project-codes.js";

export function projectCodesRouter(deps: { resolveWorkspaceRoots: () => string[] }): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    try {
      const document = loadProjectCodes(deps.resolveWorkspaceRoots());
      return c.json({ source_path: document.sourcePath, categories: document.categories });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 503);
    }
  });
  return app;
}
