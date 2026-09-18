import { describe, it, expect, vi } from "vitest";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { makeTestDb, makeTestDir } from "../helpers/db.js";
import { SessionsRepo } from "../../src/db/sessions-repo.js";
import { ProjectCodesRepo } from "../../src/db/project-codes-repo.js";
import { ConfluxService } from "../../src/harness/reliability/conflux-service.js";
import { parseConfluxSelection, switchObstacle } from "../../src/harness/reliability/conflux-policy.js";
import { inspectConfluxGit, switchConfluxGit, type ConfluxGitState } from "../../src/harness/reliability/conflux-git.js";
import { TaskBranchService } from "../../src/harness/reliability/task-branch-service.js";
import { harnessConfluxRouter } from "../../src/api/harness-conflux.js";
const selection = { projectCode: "KD", tide: "speed", variant: "light", baseBranch: "evolution/speed/light/main", workBranch: "feature/speed/light/scoring" };
function fixture() {
  const db = makeTestDb(); const sessions = new SessionsRepo(db); const projects = new ProjectCodesRepo(db);
  const repo = resolve("fixture-conflux");
  projects.register({ code: "KD", project: "Fixture", repoPath: repo, repoOrigin: "LUDIARS/Fixture", addedBy: "fixture" });
  projects.setRevisorWorkflow("KD", "github"); projects.update("KD", { confluxFlow: true });
  sessions.insertSession({ id: "cf", provider: "claude-code", repo_path: repo, repo_origin: "LUDIARS/Fixture",
    branch: "feature/old", host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: '{}' });
  const state: ConfluxGitState = { repo, branch: "feature/old", dedicated: true, dirty: false, baseExists: true, workExists: false, descends: false };
  const inspect = vi.fn(async () => ({ ...state }));
  const change = vi.fn(async () => { Object.assign(state, { branch: selection.workBranch, workExists: true, descends: true }); });
  const service = new ConfluxService(sessions, projects, inspect, change);
  return { db, sessions, projects, state, inspect, change, service, action: { tool: "Edit", cwd: repo } };
}
describe("Conflux work isolation", () => {
  it("requires a matching selection and leaves the review workflow independent", async () => {
    const f = fixture();
    expect(f.projects.findByCode("KD")?.revisor_workflow).toBe("github");
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.change).not.toHaveBeenCalled();
    expect(() => f.service.select("cf", { ...selection, projectCode: "Mp" })).toThrow();
    f.projects.update("KD", { confluxFlow: false });
    expect((await f.service.gate("cf", f.action)).active).toBe(false);
    expect(f.projects.findByCode("KD")?.revisor_workflow).toBe("github");
  });
  it("switches a clean dedicated worktree and blocks the original edit for retry", async () => {
    const f = fixture(); f.service.select("cf", selection);
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.change).toHaveBeenCalledOnce();
    expect(f.sessions.findSession("cf")?.branch).toBe(selection.workBranch);
    expect((await f.service.gate("cf", f.action)).hit).toBeNull();
  });
  it.each([{ dirty: true }, { dedicated: false }, { baseExists: false }, { workExists: true, descends: false }])("preserves an unsafe checkout %j", async patch => {
    const f = fixture(); Object.assign(f.state, patch); f.service.select("cf", selection);
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.sessions.findSession("cf")?.branch).toBe("feature/old");
  });
  it("does not switch another active session's checkout", async () => {
    const f = fixture(); f.service.select("cf", selection);
    f.sessions.insertSession({ id: "peer", provider: "claude-code", repo_path: f.state.repo, repo_origin: "LUDIARS/Fixture",
      branch: "feature/old", host: "fixture", started_at: 1, last_seen_at: 1, transcript_path: null, metadata: '{}' });
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny"); expect(f.change).not.toHaveBeenCalled();
  });
  it("does not grant edit permission when switching fails", async () => {
    const f = fixture(); f.service.select("cf", selection); f.change.mockRejectedValueOnce(new Error("used elsewhere"));
    expect((await f.service.gate("cf", f.action)).hit?.decision).toBe("deny");
    expect(f.sessions.findSession("cf")?.branch).toBe("feature/old");
  });
  it("preserves the submitted task boundary after successful flow matching", async () => {
    const f = fixture(); f.service.select("cf", selection); await f.service.gate("cf", f.action);
    const tasks = new TaskBranchService(f.sessions, async () => ({ repo: f.state.repo, branch: f.state.branch, mainExists: true }), (id, action) => f.service.gate(id, action));
    tasks.submitted("cf", { repo: f.state.repo, branch: f.state.branch, task: "scoring" }, "pr-1");
    f.sessions.patchSession("cf", { current_task: "unrelated work" });
    expect((await tasks.gate("cf", f.action))?.rule).toBe("submitted-task-boundary");
  });
  it("offers selection through the harness API without claiming checkout success", async () => {
    const f = fixture(); const app = harnessConfluxRouter(f.service);
    const response = await app.request("/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "cf", selection }) });
    expect(await response.json()).toEqual({ selected: true, checked: false }); expect(f.change).not.toHaveBeenCalled();
  });
  it("accepts either explicit main naming and rejects cross-flow or shell names", () => {
    expect(parseConfluxSelection(selection)).toEqual(selection);
    expect(parseConfluxSelection({ ...selection, baseBranch: "evolution/speed/light" })).not.toBeNull();
    expect(parseConfluxSelection({ ...selection, workBranch: "feature/other/light/task" })).toBeNull();
    expect(parseConfluxSelection({ ...selection, tide: "speed;echo" })).toBeNull();
    expect(switchObstacle({ dedicated: true, peers: false, dirty: true })).not.toBeNull();
  });
  it("creates from the selected local base and detects dirty state using real Git", async () => {
    const dir = makeTestDir("conflux-git-");
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
    git(["init", "-b", "main"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    git(["branch", selection.baseBranch]); const wt = join(dir, "work"); git(["worktree", "add", "-b", "feature/old", wt, "main"]);
    expect((await inspectConfluxGit(dir, selection)).dedicated).toBe(false);
    expect((await inspectConfluxGit(wt, selection)).dedicated).toBe(true);
    await switchConfluxGit(wt, selection, false);
    expect(await inspectConfluxGit(wt, selection)).toMatchObject({ branch: selection.workBranch, descends: true, dirty: false });
    writeFileSync(join(wt, "pending.txt"), "preserve");
    expect((await inspectConfluxGit(wt, selection)).dirty).toBe(true);
    // Multiple real Git inspections need process-startup headroom under parallel review.
  }, 60_000);
});
