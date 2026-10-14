import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBuildScript } from "./build.js";
import { DEVELOP_DIR, resolveClonePaths } from "./clone-paths.js";

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function workspace(): string {
  root = mkdtempSync(join(tmpdir(), "cc-clone-paths-"));
  return root;
}

describe("resolveClonePaths", () => {
  it("finds the main and develop clones by their .git marker", async () => {
    const ws = workspace();
    mkdirSync(join(ws, "Repo", ".git"), { recursive: true });
    mkdirSync(join(ws, DEVELOP_DIR, "Repo", ".git"), { recursive: true });
    expect(await resolveClonePaths("Repo", [ws])).toEqual({ main: join(ws, "Repo"), develop: join(ws, DEVELOP_DIR, "Repo") });
  });

  it("returns null for a directory without .git and prefers the first root", async () => {
    const first = workspace();
    mkdirSync(join(first, "NoGit"), { recursive: true });
    expect(await resolveClonePaths("NoGit", [first])).toEqual({ main: null, develop: null });
    mkdirSync(join(first, "Repo", ".git"), { recursive: true });
    expect((await resolveClonePaths("Repo", [first, join(first, "other")])).main).toBe(join(first, "Repo"));
  });
});

describe("hasBuildScript", () => {
  it("is true only for a package.json with a non-empty build script", async () => {
    const ws = workspace();
    expect(await hasBuildScript(ws)).toBe(false);
    writeFileSync(join(ws, "package.json"), "{ broken");
    expect(await hasBuildScript(ws)).toBe(false);
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { build: " " } }));
    expect(await hasBuildScript(ws)).toBe(false);
    writeFileSync(join(ws, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    expect(await hasBuildScript(ws)).toBe(true);
  });
});
