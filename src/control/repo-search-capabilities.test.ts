import { expect, it } from "vitest";
import { createRepositorySearchService } from "./repo-search-capabilities.js";
import type { RepositorySearchSnapshot } from "./repo-search-policy.js";

it("coalesces same repository/provider, expires it, and separates a provider switch", async () => {
  let now = 0;
  let calls = 0;
  const snapshot = (provider: string): RepositorySearchSnapshot => ({ root: "/repo", provider, observedAt: "now",
    rootFiles: ["Cargo.toml"], extensions: { ".rs": 2 }, sampleLimited: false, sampleReasons: [],
    binaries: { "rust-analyzer": true }, configuredServers: [], pathLimited: false });
  const inspect = createRepositorySearchService({ identity: async () => "repo:1", now: () => now,
    inspect: async (_root, provider) => { calls++; await Promise.resolve(); return snapshot(provider); } });
  const [first, second] = await Promise.all([inspect("/repo", "codex-cli"), inspect("/repo", "codex-cli")]);
  expect(first).toBe(second);
  expect(calls).toBe(1);
  expect((await inspect("/repo", "claude-code")).provider).toBe("claude-code");
  expect(calls).toBe(2);
  now = 300_001;
  await inspect("/repo", "codex-cli");
  expect(calls).toBe(3);
});
