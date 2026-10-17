import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasDddEvidenceAsync, resolveDddEvidenceRoot } from "./ddd-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function checkout(base: string, name: string, { domain }: { domain: boolean }): string {
  const root = join(base, name);
  mkdirSync(join(root, "spec", "ux"), { recursive: true });
  mkdirSync(join(root, "spec", "domains"), { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: elsewhere\n");
  writeFileSync(join(root, "spec", "ux", "flow.md"), "# flow\n");
  if (domain) {
    writeFileSync(join(root, "spec", "domains", "fresh.domain.json"),
      JSON.stringify({ specRefs: ["spec/feature/fresh.md"], membership: [{ pathPattern: "(^|/)src/fresh/[^/]+$" }] }));
  }
  return root;
}

describe("DDD evidence root (Actio cbabb7a8)", () => {
  it("judges an edit in a worktree by that worktree's domains, not the registered main checkout", async () => {
    const base = mkdtempSync(join(tmpdir(), "cc-ddd-root-"));
    roots.push(base);
    const main = checkout(base, "main", { domain: false });
    const worktree = checkout(base, "wt", { domain: true });
    const file = join(worktree, "src", "fresh", "index.ts");

    expect(await hasDddEvidenceAsync(main, file)).toBe(false);
    const root = await resolveDddEvidenceRoot(main, file);
    expect(root).toBe(worktree);
    expect(await hasDddEvidenceAsync(root, file)).toBe(true);
  });

  it("falls back to the registered root when no checkout encloses the file", async () => {
    const base = mkdtempSync(join(tmpdir(), "cc-ddd-root-"));
    roots.push(base);
    const loose = join(base, "loose", "file.ts");
    expect(await resolveDddEvidenceRoot(join(base, "registered"), loose)).toBe(join(base, "registered"));
  });
});
