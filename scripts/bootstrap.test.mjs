import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Canalis dependency provisioning", () => {
  it("installs no development dependencies or hooks and applies the completion guard after compilation", async () => {
    vi.resetModules();
    const exec = vi.fn();
    vi.doMock("node:child_process", () => ({ execFileSync: exec }));
    vi.doMock("node:fs", () => ({ existsSync: () => true }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await import("./bootstrap.mjs");
    const calls = exec.mock.calls;
    const canalis = calls.filter(([, , opts]) => /[\\/]lib[\\/]canalis$/.test(opts.cwd));
    expect(canalis).toHaveLength(1);
    expect(canalis[0][1]).toEqual(expect.arrayContaining(["ci", "--omit=dev", "--ignore-scripts"]));
    expect(canalis[0][1]).not.toContain("--include=dev");
    const compile = calls.findIndex(([, args]) => args.includes("tsconfig.canalis.json"));
    const patch = calls.findIndex(([, args]) => args.some((arg) => /patch-canalis-notion\.mjs$/.test(arg)));
    expect(compile).toBeGreaterThan(-1);
    expect(patch).toBeGreaterThan(compile);
    expect(calls.some(([, args]) => args.some((arg) => /playwright.*cli/.test(arg)))).toBe(false);
  });
});
