// @spec 初期ポリシーの版と照合
import { expect, it } from "vitest";
import { buildStartupPolicy, startupPolicyDelta } from "./startup-policy.js";
import { buildSharedStartupContext } from "./shared-startup-context.js";

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

it("omits workflow advice and retires a stored startup decision", async () => {
  const input = { repoPath: "E:/fixture", observedBranch: "feat/work", provider: "codex-cli",
    pendingSpawn: null, workspaceRoots: [], requirements: null };
  const github = (await buildStartupPolicy({ ...input, workflow: "github" })).policy;
  const revisor = (await buildStartupPolicy({ ...input, workflow: "revisor" })).policy;
  expect(github).toEqual(revisor);
  expect(github.fields).not.toHaveProperty("workflow");
  expect(github.text).not.toMatch(/Workflow|Revisor 作業手順|GitHub PR/);
  const legacy = { ...github, revision: "old", fields: { ...github.fields, workflow: "github" } };
  expect(startupPolicyDelta(legacy, github)).toContain("過去の起動案内に含まれるワークフロー判定・提出手順は無効");
});

it("does not discover workflow-specific skills at startup", async () => {
  const paths: string[] = [];
  const text = await buildSharedStartupContext({ workflow: "revisor", repoPath: "E:/fixture/project",
    projectRoot: "E:/fixture/project", workspaceRoots: ["E:/fixture"],
    readableFile: async (path) => { paths.push(path); return true; } });
  expect(text).not.toContain("Revisor 作業手順");
  expect(paths.some((path) => path.includes("revisor-cc-workflow"))).toBe(false);
});
