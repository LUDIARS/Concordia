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
  expect(policy.text).toContain("作業 branch の push");
  repo.mergeMetadata("policy-fixture", { [STARTUP_POLICY_KEY]: policy });
  expect(await refreshStartupPolicy(deps, "policy-fixture")).toMatchObject({ changed: false, delivery: "unconfirmed" });
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(0);
});

it("repairs missing policy and emits only the workflow correction on change", async () => {
  const { repo, deps, state } = fixture();
  expect((await refreshStartupPolicy(deps, "policy-fixture")).changed).toBe(true);
  state.workflow = "revisor";
  expect((await refreshStartupPolicy(deps, "policy-fixture")).changed).toBe(true);
  const events = repo.recentEvents("policy-fixture", 10);
  expect(events).toHaveLength(2);
  const update = events.map((event) => JSON.parse(event.payload).text as string).find((text) => text.includes("[Cc policy update]"))!;
  expect(update).toContain("session 自身は push");
  expect(update).not.toContain("resources:");
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

it("downgrades to unknown when workflow lookup is unavailable", async () => {
  const { deps, repo } = fixture();
  await refreshStartupPolicy(deps, "policy-fixture");
  deps.resolveProjectStartupWorkflow = async () => { throw new Error("unavailable"); };
  await refreshStartupPolicy(deps, "policy-fixture");
  const snapshot = readStartupPolicy(repo.findSession("policy-fixture")!.metadata)!;
  expect(snapshot.fields.workflow).toBe("unknown");
  expect(snapshot.text).toContain("workflow を推測しない");
});

it("does not publish a stale resolution after the branch changes", async () => {
  const { deps, repo } = fixture();
  let finish!: (value: ProjectStartupWorkflow) => void;
  deps.resolveProjectStartupWorkflow = () => new Promise((resolve) => { finish = resolve; });
  const pending = refreshStartupPolicy(deps, "policy-fixture");
  repo.patchSession("policy-fixture", { branch: "feat/new" });
  finish("github");
  expect(await pending).toMatchObject({ stale: true, changed: false });
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(0);
});

it("deduplicates simultaneous checks", async () => {
  const { deps, repo } = fixture();
  await Promise.all([refreshStartupPolicy(deps, "policy-fixture"), refreshStartupPolicy(deps, "policy-fixture")]);
  expect(repo.recentEvents("policy-fixture", 10)).toHaveLength(1);
});
