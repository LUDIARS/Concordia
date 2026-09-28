// @implements CC-COMMAND-CATALOG-01: project-scoped manifest listing through Cc's trusted CLI.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readCatalogProcess } from "./command-catalog.js";

const Script = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  description: z.string(),
  arguments: z.array(z.object({ name: z.string(), required: z.boolean() })),
  requiredPermissions: z.array(z.string()),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  verified: z.boolean(),
}).strict();
export type GeneratedScript = z.infer<typeof Script>;

export interface RegisteredProject { code: string; project: string; repo_path: string }

export function parseGeneratedScripts(output: string): GeneratedScript[] {
  let data: unknown;
  try { data = JSON.parse(output); }
  catch { throw new Error("script_catalog_format_changed"); }
  const parsed = z.array(Script).safeParse(data);
  if (!parsed.success) throw new Error("script_catalog_format_changed");
  return parsed.data;
}

export async function resolveRegisteredRepo(
  code: string,
  projects: readonly RegisteredProject[],
  workspaceRoots: readonly string[],
): Promise<string> {
  const project = projects.find(entry => entry.code === code);
  if (!project) throw new Error("project_code_not_found");
  if (!isAbsolute(project.repo_path)) throw new Error("registered_repository_invalid");
  const repo = await realpath(project.repo_path).catch(() => { throw new Error("registered_repository_unavailable"); });
  if (!(await stat(repo)).isDirectory()) throw new Error("registered_repository_invalid");
  for (const root of workspaceRoots) {
    const actualRoot = await realpath(root).catch(() => null);
    if (!actualRoot) continue;
    const rel = relative(resolve(actualRoot), repo);
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return repo;
  }
  throw new Error("registered_repository_outside_workspace");
}

export async function listGeneratedScripts(ccRoot: string, repo: string): Promise<GeneratedScript[]> {
  const cli = resolve(ccRoot, "tools", "command-tools", "cli.mjs");
  return parseGeneratedScripts(await readCatalogProcess(cli, ["script:list", "--repo", repo], ccRoot));
}
