import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRepositorySearchSnapshot } from "./repo-search-snapshot.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("finds source languages in a bounded host sample without printing config values", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-search-")); dirs.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".claude"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "tsconfig.json"), "{}", "utf8");
  await writeFile(join(root, "src", "main.ts"), "export const x = 1", "utf8");
  await writeFile(join(root, "node_modules", "ignored.py"), "", "utf8");
  await writeFile(join(root, ".claude", "settings.json"), '{"enabledPlugins":{"rust-analyzer-lsp@official":true,"clangd-lsp@official":false},"secret":"secret-value"}', "utf8");
  const snapshot = await readRepositorySearchSnapshot(root, "claude-code");
  expect(snapshot.extensions[".ts"]).toBe(1);
  expect(snapshot.extensions[".py"]).toBeUndefined();
  expect(snapshot.configuredServers).toContain("rust-analyzer");
  expect(snapshot.configuredServers).not.toContain("clangd");
  expect(JSON.stringify(snapshot)).not.toContain("secret-value");
});
