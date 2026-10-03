import { describe, expect, it } from "vitest";
import { preflightMigrations, type MigrationRepository } from "./preflight.js";

const source = (name: string) => `export const MIGRATIONS = [{version:42,name:"${name}",source:"s",up(db){}}];`;
function repository(): MigrationRepository {
  return {
    resolve: ref => ref === "HEAD" ? "target" : "main",
    unmergedBranches: () => [{ ref: "refs/heads/peer", sha: "peer" }, { ref: "refs/heads/self", sha: "target" }],
    mergeBase: () => "base",
    schema: sha => sha === "base" ? "export const MIGRATIONS = [];" : source(sha),
  };
}
describe("migration preflight application", () => {
  it("compares pinned HEAD with local main and unmerged branches, skipping self", () => {
    const report = preflightMigrations(repository());
    expect(report.target).toEqual({ ref: "HEAD", sha: "target" });
    expect(report.comparisons.map(x => x.ref)).toEqual(["refs/heads/main", "refs/heads/peer"]);
    expect(report.comparisons.every(x => x.ancestor === "base" && x.collisions.length === 1)).toBe(true);
  });
  it("uses an explicit ref and parses even when there are no comparisons", () => {
    const repo = repository();
    repo.unmergedBranches = () => [];
    expect(preflightMigrations(repo, "main").target.ref).toBe("main");
    repo.schema = () => "unsupported";
    expect(() => preflightMigrations(repo, "main")).toThrow();
  });
  it.each(["resolve", "unmergedBranches", "mergeBase", "schema"] as const)("propagates %s failure", method => {
    const repo = repository();
    repo[method] = () => { throw new Error("read failure"); };
    expect(() => preflightMigrations(repo)).toThrow("read failure");
  });
  it("does not suppress a malformed peer schema", () => {
    const repo = repository();
    const read = repo.schema;
    repo.schema = sha => sha === "peer" ? "invalid schema" : read(sha);
    expect(() => preflightMigrations(repo)).toThrow();
  });
});
