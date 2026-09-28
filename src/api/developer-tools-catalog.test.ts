import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { developerToolsRouter } from "./developer-tools.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("lists only registered projects and sends the selected canonical repo to the trusted reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-catalog-api-"));
  temporary.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const generatedScripts = vi.fn().mockResolvedValue([]);
  const app = developerToolsRouter({ execute: vi.fn() }, {
    projects: () => [{ code: "cc", project: "Concordia", repo_path: repo }],
    workspaceRoots: () => [root], ccRoot: root,
    commonCommands: vi.fn().mockResolvedValue([]), generatedScripts,
  });
  const projects = await app.request("/scripts/projects");
  expect(await projects.json()).toEqual({ projects: [{ code: "cc", project: "Concordia" }] });
  const unknown = await app.request("/scripts?code=other");
  expect(unknown.status).toBe(404);
  const listing = await app.request("/scripts?code=cc");
  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual({ code: "cc", scripts: [] });
  expect(generatedScripts).toHaveBeenCalledWith(root, await realpath(repo));
});

it("keeps source failures distinct from zero entries", async () => {
  const app = developerToolsRouter({ execute: vi.fn() }, {
    projects: () => [], workspaceRoots: () => [], ccRoot: ".",
    commonCommands: vi.fn().mockRejectedValue(new Error("timeout")),
  });
  const response = await app.request("/commands");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "command_catalog_unavailable" });
});
