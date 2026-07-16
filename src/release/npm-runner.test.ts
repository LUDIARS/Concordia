import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClone } from "./build.js";
import { createNpmInvocation } from "./npm-runner.js";

describe("createNpmInvocation", () => {
  it("uses ComSpec for npm.cmd on Windows while preserving argv", () => {
    expect(createNpmInvocation(
      ["run", "build"],
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    )).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", "run", "build"],
    });
  });

  it("executes npm directly on non-Windows platforms", () => {
    expect(createNpmInvocation(["ci"], "linux", {})).toEqual({
      executable: "npm",
      args: ["ci"],
    });
  });

  it("fails explicitly when Windows has no ComSpec", () => {
    expect(() => createNpmInvocation(["ci"], "win32", {})).toThrow("ComSpec is not set");
  });
});

describe("buildClone", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses the same npm runner for ci and build", async () => {
    const root = mkdtempSync(join(tmpdir(), "concordia-build-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf8");
    const runner = vi.fn(async () => undefined);

    await expect(buildClone(root, runner)).resolves.toEqual({ ok: true, ran: true });
    expect(runner).toHaveBeenNthCalledWith(1, root, ["ci"], expect.any(Number));
    expect(runner).toHaveBeenNthCalledWith(2, root, ["run", "build"], expect.any(Number));
  });
});
