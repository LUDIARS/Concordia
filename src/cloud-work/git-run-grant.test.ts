import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRunGrants, type GitRunGrantInput } from "./git-run-grant.js";

const input: GitRunGrantInput = { targetId: "target", attemptId: "run", repositoryKey: "repo",
  provider: "codex-cloud", sourceRevision: "a".repeat(40), issuedAt: 1000, expiresAt: 5000, maxPackBytes: 1000 };
describe("run-bound Git grants", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cc-git-grant-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("persists only a hash and requires the exact target, attempt and expiry", async () => {
    const store = new GitRunGrants(root);
    const { token, grant } = await store.issue(input);
    expect(await readFile(join(store.directory("target", "run"), "grant.json"), "utf8")).not.toContain(token);
    await expect(store.authorize("target", "run", token, 1000)).resolves.toEqual(grant);
    await expect(store.authorize("target", "run", token, 5000)).rejects.toThrow();
    await expect(store.authorize("target", "run", token, 999)).rejects.toThrow();
    await expect(store.authorize("target", "other", token, 2000)).rejects.toThrow();
    await expect(store.authorize("other", "run", token, 2000)).rejects.toThrow();
    await expect(store.authorize("target", "run", "X".repeat(43), 2000)).rejects.toThrow();
  });
  it("never replaces a token on repeated or concurrent issuance", async () => {
    const store = new GitRunGrants(root);
    const results = await Promise.allSettled([store.issue(input), store.issue(input)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("rejects unsafe identifiers and excessive lifetime before writing", async () => {
    const store = new GitRunGrants(root);
    await expect(store.issue({ ...input, attemptId: "../escape" })).rejects.toThrow();
    await expect(store.issue({ ...input, expiresAt: 1000 + 7 * 60 * 60 * 1000 })).rejects.toThrow();
    await expect(store.issue({ ...input, maxPackBytes: 512_000_001 })).rejects.toThrow();
  });
});
