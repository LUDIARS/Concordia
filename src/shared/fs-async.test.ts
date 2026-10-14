import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathExists } from "./fs-async.js";

describe("pathExists", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("is true for an existing file or directory and false for a missing path", async () => {
    dir = mkdtempSync(join(tmpdir(), "cc-fs-async-"));
    writeFileSync(join(dir, "a.txt"), "x");
    expect(await pathExists(dir)).toBe(true);
    expect(await pathExists(join(dir, "a.txt"))).toBe(true);
    expect(await pathExists(join(dir, "missing.txt"))).toBe(false);
  });
});
