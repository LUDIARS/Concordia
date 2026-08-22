import { basename } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  ProjectCodeConflictError,
  type ProjectCodesRepo,
} from "../db/project-codes-repo.js";
import { inspectImplementationRepo, isWithinWorkspace } from "../implementation-tools/repo-context.js";

const RegisterSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,31}$/),
  repo_path: z.string().trim().min(1).max(1_000),
  added_by: z.string().trim().min(1).max(200).default("api"),
}).strict();

export function projectCodesRouter(deps: {
  repo: ProjectCodesRepo;
  resolveWorkspaceRoots: () => string[];
}): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const rows = deps.repo.list();
    return c.json({
      source: "concordia-db",
      project_codes: rows,
      categories: rows.length === 0
        ? []
        : [{ name: "Concordia registry", entries: rows.map((row) => [row.code, row.project]) }],
    });
  });

  app.post("/", async (c) => {
    const parsed = RegisterSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_project_code", detail: parsed.error.flatten() }, 400);

    const workspaceRoots = deps.resolveWorkspaceRoots();
    if (!await isWithinWorkspace(parsed.data.repo_path, workspaceRoots)) {
      return c.json({ error: "repository_outside_workspace" }, 400);
    }

    const context = await inspectImplementationRepo(parsed.data.repo_path).catch(() => null);
    if (!context) return c.json({ error: "invalid_git_repository" }, 400);
    if (!await isWithinWorkspace(context.repoPath, workspaceRoots)) {
      return c.json({ error: "repository_outside_workspace" }, 400);
    }

    try {
      const result = deps.repo.register({
        code: parsed.data.code,
        project: basename(context.repoPath),
        repoPath: context.repoPath,
        repoOrigin: context.repoOrigin,
        addedBy: parsed.data.added_by,
      });
      return c.json({ project_code: result.row, created: result.created }, result.created ? 201 : 200);
    } catch (error) {
      if (error instanceof ProjectCodeConflictError) {
        return c.json({ error: "project_code_conflict", field: error.field }, 409);
      }
      throw error;
    }
  });

  return app;
}
