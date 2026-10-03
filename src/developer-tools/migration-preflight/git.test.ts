import { describe, expect, it, vi } from "vitest";
import { GitMigrationRepository } from "./git.js";

const sha = "a".repeat(40);
describe("read-only Git migration adapter", () => {
  it("uses only fixed read commands with SHA-pinned content", () => {
    const read = vi.fn((args: readonly string[]) => {
      if (args[0] === "for-each-ref") return `refs/heads/peer\t${sha}\n`;
      if (args[0] === "show") return "schema";
      return sha + "\n";
    });
    const repo = new GitMigrationRepository(read);
    expect(repo.resolve("HEAD")).toBe(sha);
    expect(repo.unmergedBranches(sha)).toEqual([{ ref: "refs/heads/peer", sha }]);
    expect(repo.mergeBase(sha, sha)).toBe(sha);
    expect(repo.schema(sha)).toBe("schema");
    expect(read.mock.calls.map(([args]) => args)).toEqual([
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
      ["for-each-ref", `--no-merged=${sha}`, "--format=%(refname)%09%(objectname)", "refs/heads/"],
      ["merge-base", "--all", sha, sha], ["show", `${sha}:src/db/schema.ts`],
    ]);
  });
  it("rejects option-looking refs before invoking Git", () => {
    const read = vi.fn();
    expect(() => new GitMigrationRepository(read).resolve("--help")).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects malformed output and ambiguous merge bases", () => {
    for (const output of ["", "not-a-sha", `${sha}\n${sha}`]) {
      const repo = new GitMigrationRepository(() => output);
      expect(() => repo.resolve("HEAD")).toThrow();
      expect(() => repo.mergeBase(sha, sha)).toThrow();
    }
    expect(() => new GitMigrationRepository(() => "bad row").unmergedBranches(sha)).toThrow();
  });
});
