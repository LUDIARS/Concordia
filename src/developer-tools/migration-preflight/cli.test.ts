import { describe, expect, it, vi } from "vitest";
import { runMigrationPreflightCli } from "./cli.js";

describe("migration CLI output contract", () => {
  const target = { ref: "HEAD", sha: "a".repeat(40) };
  it("returns 0 with machine-readable JSON when clear", () => {
    const result = runMigrationPreflightCli([], () => ({ target, comparisons: [] }));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ target, comparisons: [] });
    expect(result.stderr).toBe("");
  });
  it("returns 1 with conflict identities", () => {
    const result = runMigrationPreflightCli(["feature"], ref => ({
      target: { ...target, ref }, comparisons: [{ ...target, ancestor: target.sha,
        collisions: [{ version: 42, leftName: "a", rightName: "b" }] }],
    }));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).target.ref).toBe("feature");
  });
  it("returns 2 and no success JSON on read or syntax failures", () => {
    const result = runMigrationPreflightCli([], () => { throw new Error("schema missing"); });
    expect(result).toMatchObject({ exitCode: 2, stdout: "" });
    expect(result.stderr).toContain("schema missing");
  });
  it("validates arguments without reading Git", () => {
    const run = vi.fn();
    expect(runMigrationPreflightCli(["a", "b"], run).exitCode).toBe(2);
    expect(runMigrationPreflightCli(["--unknown"], run).exitCode).toBe(2);
    expect(runMigrationPreflightCli(["--help"], run).exitCode).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
