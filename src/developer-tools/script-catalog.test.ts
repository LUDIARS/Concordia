import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { parseGeneratedScripts, resolveRegisteredRepo } from "./script-catalog.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("rejects invalid script output while accepting an empty registered catalog", () => {
  expect(parseGeneratedScripts("[]")).toEqual([]);
  expect(() => parseGeneratedScripts("partial output")).toThrow("script_catalog_format_changed");
  expect(() => parseGeneratedScripts('[{"id":"x"}]')).toThrow("script_catalog_format_changed");
});

it("uses only a registered canonical repository inside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cc-catalog-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "cc-catalog-outside-"));
  temporary.push(workspace, outside);
  const repo = join(workspace, "repo");
  await mkdir(repo);
  const link = join(workspace, "linked-outside");
  await symlink(outside, link, "junction");
  const projects = [
    { code: "good", project: "Good", repo_path: repo },
    { code: "escape", project: "Escape", repo_path: link },
  ];
  expect(await resolveRegisteredRepo("good", projects, [workspace])).toBe(await realpath(repo));
  await expect(resolveRegisteredRepo("missing", projects, [workspace])).rejects.toThrow("project_code_not_found");
  await expect(resolveRegisteredRepo("escape", projects, [workspace])).rejects.toThrow("registered_repository_outside_workspace");
  const file = join(workspace, "file");
  await writeFile(file, "x");
  await expect(resolveRegisteredRepo("file", [{ code: "file", project: "File", repo_path: file }], [workspace]))
    .rejects.toThrow("registered_repository_invalid");
});
