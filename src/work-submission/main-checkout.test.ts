import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mainCheckoutPath } from "./main-checkout.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "cc-main-checkout-"));
  roots.push(root);
  return root;
}

describe("mainCheckoutPath", () => {
  it("resolves a linked worktree to its main checkout through gitdir + commondir", async () => {
    const root = workspace();
    const main = join(root, "Concordia");
    const metadata = join(main, ".git", "worktrees", "fix-x");
    mkdirSync(metadata, { recursive: true });
    writeFileSync(join(metadata, "commondir"), "../..\n");
    const worktree = join(root, "Concordia-fix-x");
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), `gitdir: ${metadata}\n`);
    expect(resolve(await mainCheckoutPath(worktree))).toBe(resolve(main));
  });

  it("keeps a main checkout (a .git directory) and unreadable paths as given", async () => {
    const root = workspace();
    mkdirSync(join(root, "Repo", ".git"), { recursive: true });
    expect(await mainCheckoutPath(join(root, "Repo"))).toBe(join(root, "Repo"));
    expect(await mainCheckoutPath(join(root, "missing"))).toBe(join(root, "missing"));
  });
});
