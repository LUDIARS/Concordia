import { expect, it } from "vitest";
import { classifyRepositorySearch, formatRepositorySearchGuidance } from "./repo-search-policy.js";

it("keeps host installation, provider configuration, and remote callability distinct", () => {
  const result = classifyRepositorySearch({ root: "/repo", provider: "claude-code", observedAt: "now",
    rootFiles: ["tsconfig.json"], extensions: { ".ts": 7 }, sampleLimited: false, sampleReasons: [], pathLimited: false,
    binaries: { rg: true, "typescript-language-server": true }, configuredServers: [] });
  expect(result.languages).toContain("typescript");
  expect(result.tools.find((tool) => tool.name === "typescript-language-server"))
    .toEqual({ name: "typescript-language-server", installed: "yes", configured: "unknown", callable: "unknown" });
  expect(formatRepositorySearchGuidance(result)).toContain("作業先で利用できる検索手段を確認");
  expect(formatRepositorySearchGuidance(result)).not.toContain("Anatomiaのドメイン索引");
  expect(formatRepositorySearchGuidance(result)).toContain("リファクタリング・全体調査はピンポイント検索の対象外");
});
