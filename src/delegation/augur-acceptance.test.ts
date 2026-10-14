import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUGUR_CONTRACTS_FILE, hasAcceptanceContract, resolveAugurCliPath } from "./augur-acceptance.js";

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("hasAcceptanceContract", () => {
  it("detects the contract file in the checkout", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-augur-acceptance-"));
    expect(await hasAcceptanceContract(dir)).toBe(false);
    writeFileSync(join(dir, AUGUR_CONTRACTS_FILE), "{}");
    expect(await hasAcceptanceContract(dir)).toBe(true);
  });
});

describe("resolveAugurCliPath", () => {
  it("prefers CONCORDIA_AUGUR_DIR, then the first workspace root holding Augur", async () => {
    const seen: string[] = [];
    const exists = async (path: string) => { seen.push(path); return path.includes("second"); };
    expect(await resolveAugurCliPath({ workspaceRoots: ["/first", "/second"], exists }))
      .toBe(join("/second", "Augur", "bin", "augur.mjs"));
    expect(seen).toHaveLength(2);
    expect(await resolveAugurCliPath({ env: { CONCORDIA_AUGUR_DIR: "/explicit" }, workspaceRoots: ["/second"], exists }))
      .toBeNull();
  });

  it("finds a real CLI on disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-augur-cli-"));
    mkdirSync(join(dir, "Augur", "bin"), { recursive: true });
    writeFileSync(join(dir, "Augur", "bin", "augur.mjs"), "");
    expect(await resolveAugurCliPath({ workspaceRoots: [dir] })).toBe(join(dir, "Augur", "bin", "augur.mjs"));
  });
});
