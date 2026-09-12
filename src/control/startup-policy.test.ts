// @spec 初期ポリシーの版と照合
import { expect, it } from "vitest";
import { buildStartupPolicy, startupPolicyDelta } from "./startup-policy.js";

it("includes required implementation settings without granting execution permission", async () => {
  const input = { workflow: "github" as const, repoPath: "E:/fixture", observedBranch: "feat/work",
    provider: "codex-cli", pendingSpawn: null, workspaceRoots: [], requirements: null };
  const unknown = (await buildStartupPolicy(input)).policy;
  const required = (await buildStartupPolicy({ ...input, requirements: { ddd: true, tests: true, ontime: true, workContract: false } })).policy;
  expect(required.revision).not.toBe(unknown.revision);
  expect(required.text).toContain("DDD=true; tests=true; ontime=true");
  expect(required.text).toContain("実行許可を追加しません");
  expect(required.text).toContain("開始前に人間に確認してください");
  expect(required.text).toContain("同じ範囲の開始指示をすでに受けている場合");
  expect(required.text).toMatch(/session-work-phase[\\/]+SKILL\.md/);
  expect(startupPolicyDelta(unknown, required)).toContain("requirements:");
  expect(startupPolicyDelta(unknown, required)).not.toContain("resources:");
  // If initial delivery is still delayed, its replacement must be self-contained.
  expect(startupPolicyDelta({ ...unknown, delivery: "scheduled" }, required)).toBe(required.text);
});
