// @spec 初期ポリシーの版と照合
import { expect, it } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SessionsRepo } from "../../db/sessions-repo.js";
import { ProjectCodesRepo } from "../../db/project-codes-repo.js";
import { refreshStartupPolicy, registerStartupPolicyCheck, resolveStartupPolicy } from "./startup-policy-check.js";
import { STARTUP_POLICY_KEY, readStartupPolicy } from "../../control/startup-policy.js";
import type { ProjectStartupWorkflow } from "../../control/project-startup-workflow.js";

function fixture() {
  const db = makeTestDb();
  const repo = new SessionsRepo(db);
  const projectCodes = new ProjectCodesRepo(db);
  repo.insertSession({ id: "policy-fixture", provider: "codex-cli", repo_path: "E:/fixture/project",
    repo_origin: "https://example.invalid/policy.git", branch: "feat/policy", host: "fixture",
    started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null });
  const state = { workflow: "github" as ProjectStartupWorkflow };
  const deps = { repo, projectCodes, resolveWorkspaceRoots: () => [], resolveProjectStartupWorkflow: async () => state.workflow };
  const app = new Hono();
  registerStartupPolicyCheck(app, deps);
  return { db, repo, deps, state, app };
}

it("uses the initial resolver snapshot without injecting it twice", async () => {
  const { repo, deps } = fixture();
  const { policy } = await resolveStartupPolicy(deps, repo.findSession("policy-fixture")!);
  expect(policy.text).not.toContain("Workflow");
  repo.mergeMetadata("policy-fixture", { [STARTUP_POLICY_KEY]: policy });
  expect(await refreshStartupPolicy(deps, "policy-fixture")).toMatchObject({ changed: false, delivery: "unconfirmed" });
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(0);
});

it("repairs missing policy without tracking workflow changes", async () => {
  const { repo, deps, state } = fixture();
  expect((await refreshStartupPolicy(deps, "policy-fixture")).changed).toBe(true);
  state.workflow = "revisor";
  expect((await refreshStartupPolicy(deps, "policy-fixture")).changed).toBe(false);
  const events = repo.recentEvents("policy-fixture", 10);
  expect(events).toHaveLength(1);
  expect((await refreshStartupPolicy(deps, "policy-fixture")).changed).toBe(false);
});

it("reports a hook binding mismatch without replacing the registered worktree", async () => {
  const { repo, app } = fixture();
  const response = await app.request("/policy-fixture/startup-policy-check", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "E:/fixture", branch: "main", provider: "claude-code" }) });
  expect(await response.json()).toMatchObject({ ok: false, reason: "binding_mismatch" });
  expect(repo.findSession("policy-fixture")?.repo_path).toBe("E:/fixture/project");
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(0);
});

it("does not query workflow when its registry is unavailable", async () => {
  const { deps, repo } = fixture();
  await refreshStartupPolicy(deps, "policy-fixture");
  let called = false;
  deps.resolveProjectStartupWorkflow = async () => { called = true; throw new Error("unavailable"); };
  await refreshStartupPolicy(deps, "policy-fixture");
  const snapshot = readStartupPolicy(repo.findSession("policy-fixture")!.metadata)!;
  expect(snapshot.fields).not.toHaveProperty("workflow");
  expect(snapshot.text).not.toContain("Workflow");
  expect(called).toBe(false);
});

it("does not publish a stale resolution after the branch changes", async () => {
  const { deps, repo } = fixture();
  const pending = refreshStartupPolicy(deps, "policy-fixture");
  repo.patchSession("policy-fixture", { branch: "feat/new" });
  expect(await pending).toMatchObject({ stale: true, changed: false });
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(0);
});

it("deduplicates simultaneous checks", async () => {
  const { deps, repo } = fixture();
  await Promise.all([refreshStartupPolicy(deps, "policy-fixture"), refreshStartupPolicy(deps, "policy-fixture")]);
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(1);
});

it("selects the last registered work project over the startup repository", async () => {
  const { deps, repo } = fixture();
  deps.projectCodes.register({ code: "GLab", project: "GLAB", repoPath: "E:/fixture/GLAB",
    repoOrigin: "https://example.invalid/glab.git", addedBy: "fixture" });
  deps.projectCodes.update("GLab", { dddEnabled: true, testsRequired: true });
  const lookups: unknown[] = [];
  const policyDeps = { ...deps, resolveProjectStartupWorkflow: async (path: string, origin: string | null) => {
    lookups.push([path, origin]);
    return "revisor" as const;
  } };
  for (const target of ["GLab", "E:\\fixture\\GLAB", "GLAB"]) {
    repo.patchSession("policy-fixture", { target_project: target });
    const { policy } = await resolveStartupPolicy(policyDeps, repo.findSession("policy-fixture")!);
    expect(policy.fields).toMatchObject({ projectCode: "GLab",
      projectRoot: "E:/fixture/GLAB", repo: "E:/fixture/project", branch: "feat/policy" });
    expect(policy.fields.requirements).toContain("DDD=true; tests=true");
  }
  expect(lookups).toEqual([]);
});

it("does not fall back to the startup workflow for an unresolved explicit target", async () => {
  const { deps, repo } = fixture();
  repo.patchSession("policy-fixture", { target_project: "missing-code" });
  let called = false;
  deps.resolveProjectStartupWorkflow = async () => { called = true; return "github"; };
  const { policy } = await resolveStartupPolicy(deps, repo.findSession("policy-fixture")!);
  expect(policy.fields).toMatchObject({ projectCode: "unknown", requirements: "unknown" });
  expect(called).toBe(false);
});

it("does not reuse the startup origin for a local-only work project", async () => {
  const { deps, repo } = fixture();
  deps.projectCodes.register({ code: "Local", project: "Local", repoPath: "E:/fixture/local", repoOrigin: null, addedBy: "fixture" });
  repo.patchSession("policy-fixture", { target_project: "Local" });
  let observed: unknown;
  await resolveStartupPolicy({ ...deps, resolveProjectStartupWorkflow: async (path, origin) => {
    observed = [path, origin]; return "unknown";
  } }, repo.findSession("policy-fixture")!);
  expect(observed).toBeUndefined();
});

it("discards a resolution when only the work target changed while lookup was pending", async () => {
  const { deps, repo } = fixture();
  const pending = refreshStartupPolicy(deps, "policy-fixture");
  repo.patchSession("policy-fixture", { target_project: "new-project" });
  expect(await pending).toMatchObject({ stale: true, changed: false });
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(0);
});
